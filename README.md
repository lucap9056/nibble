English | [繁體中文](README.zh-TW.md)

<div align="center">
	<h1>nibble</h1>
	<p>Write HTTP and WebSocket handlers as files, and run them on your own server behind a single gateway</p>
</div>

---

## Features

### Bubbles as files

- A bubble is one `*.bubble.ts` file that exports its HTTP and WebSocket handlers
- The file path is the endpoint: `api/users.bubble.ts` serves `/api/users`, and `index` serves its folder
- Handlers take a standard `Request` and return a `Response`
- There is no server or framework to set up
- Each bubble runs in its own worker

### Gateway

- One gateway serves every bubble on a single port, routed by path
- HTTP and WebSocket go through the same gateway

### Web console

- Start, stop, route and restart bubbles, and deploy new versions without restarting nibble
- The desired state is saved and restored when nibble restarts

> [!WARNING]
> Bubbles are not sandboxed. They run inside nibble's own process with the same permissions, and can read its environment variables, files and sockets. Only run bubbles you trust.

## Getting Started

### Deploy your first bubble

Docker

```bash
mkdir bubbles
cat > bubbles/hello.bubble.ts <<'EOF'
import { define } from "@lucap9056/nibble";

export default define({
  handlers: {
    get: (req) => Response.json({ hello: new URL(req.url).searchParams.get("name") ?? "world" }),
  },
});
EOF

docker build -f docker/Dockerfile -t nibble .
docker run -d --name nibble \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 \
  --tmpfs /run/nibble \
  -v "$PWD/bubbles:/srv/nibble/bubbles" \
  -v nibble-data:/var/lib/nibble \
  nibble
```

Docker Compose:

```yaml
# docker-compose.yml
services:
  nibble:
    image: nibble
    ports:
      - "127.0.0.1:8080:8080"
      - "127.0.0.1:8081:8081"
    tmpfs:
      - /run/nibble
    volumes:
      - ./bubbles:/srv/nibble/bubbles
      - nibble-data:/var/lib/nibble

volumes:
  nibble-data:
```

```bash
docker compose up -d
```

1. Open the console at `http://localhost:8081`, sign in with `admin` and set a new password
2. Start and route `hello`
3. `curl "http://localhost:8080/hello?name=nibble"`

Edit the file, then deploy it again from the console. The new version takes over once its worker is running.

- The container starts as root, then `nibbled` switches to the owner of the mounted `bubbles` folder
- When that folder is owned by root, `nibbled` switches to `65532` (nonroot) instead
- Before switching, `nibbled` hands its data and socket dirs over to that user

### From source

Requires Bun 1.4, Go 1.27, `protoc`, [`protoc-gen-go`](https://pkg.go.dev/google.golang.org/protobuf/cmd/protoc-gen-go) and [`ts-proto`](https://github.com/stephenh/ts-proto).

```bash
bun install
bun run proto
bun run build
./dist/nibbled
```

- `dist/` holds `nibbled`, the engine `nibble` and the gateway `nibble-router`
- Data files are kept next to them
- Bubbles are read from `dist/bubbles`
- Set `BUBBLE_SOURCE_DIR` to use another folder
- The console listens on `127.0.0.1:8081` and the gateway on `127.0.0.1:8080`

---

## Development

### Architecture

```
nibbled (Go)                control plane: web console, desired state in SQLite
└─ nibble (Bun)             engine: builds snapshots, runs bubble workers
   ├─ workers               one per running bubble, each on a Unix socket
   └─ nibble-router (Go)    gateway: proxies HTTP and WebSocket to the sockets
```

- Bubbles run as long-lived workers, so there are no cold starts
- Each bubble runs one worker, with no scale-to-zero or autoscaling

| Directory | Contents |
| :--- | :--- |
| `nibble-daemon` | `nibbled`, auth and storage, with the web console in `web/` |
| `nibble-engine` | Engine: snapshots and bubble workers |
| `nibble-router` | Gateway and its protobuf schema `router.proto` |
| `nibble-sdk` | `@lucap9056/nibble`, the package bubbles import |
| `example` | Example bubbles |
| `scripts` | Build scripts |
| `tests` | Integration tests |

### Writing a Bubble

```ts
import { define } from "@lucap9056/nibble";
import { cors } from "@lucap9056/nibble/cors";

export default define({
  handlers: cors(
    { origin: "*" },
    {
      get: (req) => Response.json({ url: req.url }),
      wss: {
        onmessage: (ws, message) => {
          ws.send(message);
        },
      },
    },
  ),
});
```

- **Handlers**: `get`, `post`, `put`, `delete`, `patch`, `options`, and `wss` with `upgrade`, `onconnect`, `onmessage`, `onclose`
- **WebSocket context**: `upgrade` returns the value for `ws.data`, or a `Response` to reject
- Without `upgrade`, `ws.data` is `{ connId }` with a UUIDv7
- **CORS**: `cors()` answers preflight requests and checks the `Origin` of WebSocket upgrades
- **Entry files**: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`
- **Names**: path segments of letters, digits, `.`, `_`, `~` and `-`
- **Types**: install `@lucap9056/nibble` for editor types, and `@types/bun` for full WebSocket types
- Without `@types/bun`, WebSocket types resolve to `unknown`
- **Version**: bubbles run on the SDK built into the engine, so install the SDK matching the image, such as `~0.2.0` for image `0.2`
- See [`example/bubbles/example.bubble.ts`](example/bubbles/example.bubble.ts) for every handler

### Routing

- Requests under a bubble's route reach it with the prefix stripped
- The prefix is passed in `X-Forwarded-Prefix`
- A bubble can run without routing, then be routed once it is ready

### Snapshots and Deploys

- A snapshot bundles a bubble's source and is named by the SHA-256 of the bundled code
- Snapshots are kept in `BUBBLE_SNAPSHOT_DIR`
- A bubble keeps several snapshots
- Deploy any of them to roll forward or back
- Deploying without a snapshot builds one from the latest source
- Deploying or restarting starts a new worker, switches traffic once it is running, then stops the old one
- npm packages stay external and load from where they are installed, so keep `node_modules` next to the source

### Installing Dependencies

`nibbled install` (or `nibbled i`) runs `bun install` with the engine's own Bun:

  Docker
```bash
docker exec nibble nibbled i example --production
```
  Docker Compose
```bash
docker compose exec nibble nibbled i example --production
```

- The path is relative to `BUBBLE_SOURCE_DIR` like a bubble name, such as `example` or `api/users`
- It must stay inside that dir, contain `package.json`, and not be inside `node_modules`
- Arguments after the path are passed to `bun install` as is
- The install runs as the same user as `nibbled`, so the installed files belong to the owner of the `bubbles` folder

### Declarative Deploys

Pipe a JSON array to `nibbled` to replace the saved desired state on startup:

```bash
echo '[{ "name": "hello", "routing": true }]' | ./dist/nibbled
```

- Each entry takes `name`, `snapshotHash` and `routing`
- An empty `snapshotHash` builds the latest source
- Without stdin, `nibbled` restores the bubbles that were enabled
- Any that can no longer start are disabled

### Configuration

| Variable | Default |
| :--- | :--- |
| `ADMIN_LISTEN` | `127.0.0.1:8081` |
| `ADMIN_PUBLIC_URL` | unset, see [Console Authentication](#console-authentication) |
| `ADMIN_INITIAL_PASSWORD` | `admin` |
| `ADMIN_PASSWORD_FILE` | `nibbled.passwd` next to `nibbled` |
| `ADMIN_JWT_SECRET_FILE` | `nibbled.key` next to `nibbled`, generated on first start |
| `DATABASE_PATH` | `nibble.db` next to `nibbled` |
| `ENGINE_BINARY` | `nibble` next to `nibbled` |
| `REPORT_SOCKET` | `nibbled.sock` next to `nibbled` |
| `CONTROL_SOCKET` | `nibble.sock` next to the engine |
| `ROUTER_LISTEN` | `127.0.0.1:8080` |
| `ROUTER_BINARY` | `nibble-router` next to the engine |
| `BUBBLE_SOURCE_DIR` | `bubbles` next to the engine |
| `BUBBLE_SNAPSHOT_DIR` | `snapshots` next to the engine |
| `BUBBLE_SOCKET_DIR` | `sockets` next to the engine |
| `LOG_LEVEL` | `info` |

Set every variable on `nibbled`.

`ADMIN_LISTEN` and `ROUTER_LISTEN` also take a Unix socket, such as `unix:///run/nibble/admin.sock`.

### Console Authentication

- There is a single password
- Until it is changed, `ADMIN_INITIAL_PASSWORD` can only be used to set a new one
  - The new password is 8 to 72 bytes and differs from the initial one
  - Changing the password signs out every session
- A sign-in lasts 24 hours
- 5 failed sign-ins within 5 minutes lock sign-in for up to 5 minutes
- The console only opens on a loopback address or the host of `ADMIN_PUBLIC_URL`
- Set `ADMIN_PUBLIC_URL` when the console is served under a domain

### Console Development

The console lives in `nibble-daemon/web` (Svelte 5, TypeScript, Vite) and is embedded into `nibbled` on build.

```bash
docker compose -f docker-dev/docker-compose.yml up -d --build
cd nibble-daemon/web && bun install && bun run dev
```

- Open the address Vite prints
- Vite forwards requests to `nibbled` at `NIBBLE_ADMIN_URL` (default `http://127.0.0.1:8081`)
- `docker-dev/` mounts `example/bubbles`, signs in with `admin` and logs at `debug`
- Built with `WEB=none` (the `noweb` build tag), so `nibbled` serves no console
- Pages come from Vite
- `bun run build:daemon --noweb` builds `nibbled` without the console outside Docker

### Testing

Run `bun run proto` and `bun run build:router` first.

```bash
(cd nibble-engine && bun run test)
(cd nibble-router && go test ./...)
(cd nibble-daemon && go test ./...)
bun run test:integration
```

`test:integration` builds `dist/`, then starts `nibbled` against `example/bubbles` with its data in a temporary folder.
