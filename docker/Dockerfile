ARG WEB=embed

FROM golang:1.27 AS protoc-gen-go
RUN CGO_ENABLED=0 go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11

FROM oven/bun:1.4 AS proto
WORKDIR /src

RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
COPY --from=protoc-gen-go /go/bin/protoc-gen-go /usr/local/bin/protoc-gen-go
# protoc-gen-ts_proto starts with a node shebang; bun behaves as node when invoked through this name.
RUN ln -s "$(command -v bun)" /usr/local/bin/node \
 && bun add -g ts-proto@2.12.0
ENV PATH="/root/.bun/bin:${PATH}"

COPY scripts/proto.ts ./scripts/proto.ts
COPY nibble-router/router.proto ./nibble-router/router.proto
RUN bun scripts/proto.ts

FROM oven/bun:1.4 AS engine
WORKDIR /src

COPY package.json bun.lock ./
COPY nibble-sdk/package.json ./nibble-sdk/package.json
COPY nibble-engine/package.json ./nibble-engine/package.json
COPY example/package.json ./example/package.json
COPY scripts/package.json ./scripts/package.json
COPY tests/package.json ./tests/package.json
RUN bun install --frozen-lockfile

COPY nibble-sdk ./nibble-sdk
COPY nibble-engine ./nibble-engine
COPY scripts ./scripts
COPY --from=proto /src/nibble-engine/src/router/pb/router ./nibble-engine/src/router/pb/router
RUN bun scripts/build-engine.ts && mkdir -p /out && mv dist/nibble /out/nibble

FROM golang:1.27-alpine AS router
WORKDIR /src

COPY nibble-router/go.mod nibble-router/go.sum ./
RUN go mod download

COPY nibble-router ./
COPY --from=proto /src/nibble-router/internal/routerpb ./internal/routerpb
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/nibble-router ./cmd/router

FROM oven/bun:1.4 AS web-embed
WORKDIR /src/web

COPY nibble-daemon/web/package.json nibble-daemon/web/bun.lock ./
RUN bun install --frozen-lockfile

COPY nibble-daemon/web ./
RUN bun run build && mv dist /dist

FROM scratch AS web-none
WORKDIR /dist

FROM web-${WEB} AS web

FROM golang:1.27-alpine AS daemon
WORKDIR /src

ARG WEB

COPY nibble-daemon/go.mod nibble-daemon/go.sum ./
RUN go mod download

COPY nibble-daemon/cmd ./cmd
COPY nibble-daemon/internal ./internal
COPY nibble-daemon/web/*.go ./web/
COPY --from=web /dist ./web/dist
RUN if [ "${WEB}" = "none" ]; then GO_TAGS=noweb; fi \
 && CGO_ENABLED=0 go build -tags "${GO_TAGS}" -trimpath -ldflags="-s -w" -o /out/nibbled ./cmd/nibbled \
 && mkdir -p /out/data /out/run /out/bubbles

FROM gcr.io/distroless/cc-debian12 AS app
WORKDIR /var/lib/nibble

ENV ADMIN_LISTEN=0.0.0.0:8081 \
    ROUTER_LISTEN=0.0.0.0:8080 \
    ENGINE_BINARY=/usr/local/libexec/nibble/nibble \
    ROUTER_BINARY=/usr/local/libexec/nibble/nibble-router \
    DATABASE_PATH=/var/lib/nibble/nibble.db \
    ADMIN_JWT_SECRET_FILE=/var/lib/nibble/nibbled.key \
    ADMIN_PASSWORD_FILE=/var/lib/nibble/nibbled.passwd \
    BUBBLE_SOURCE_DIR=/srv/nibble/bubbles \
    BUBBLE_SNAPSHOT_DIR=/var/lib/nibble/snapshots \
    BUBBLE_SOCKET_DIR=/run/nibble/sockets \
    CONTROL_SOCKET=/run/nibble/nibble.sock \
    REPORT_SOCKET=/run/nibble/nibbled.sock
EXPOSE 8080 8081

COPY --from=daemon /out/nibbled /usr/local/bin/nibbled
COPY --from=engine /out/nibble /usr/local/libexec/nibble/nibble
COPY --from=router /out/nibble-router /usr/local/libexec/nibble/nibble-router
COPY --from=daemon --chown=nonroot:nonroot /out/data /var/lib/nibble
COPY --from=daemon --chown=nonroot:nonroot /out/run /run/nibble
COPY --from=daemon --chown=nonroot:nonroot /out/bubbles /srv/nibble/bubbles

ENTRYPOINT ["/usr/local/bin/nibbled"]
