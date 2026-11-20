[English](README.md) | 繁體中文

<div align="center">
	<h1>nibble</h1>
	<p>將 HTTP 與 WebSocket handler 寫成檔案，在自己的主機上透過單一 gateway 提供服務</p>
</div>

---

## 功能

### 一個檔案就是一個 Bubble

- Bubble 是一個 export HTTP 與 WebSocket handler 的 `*.bubble.ts` 檔案
- 檔案路徑就是 endpoint：`api/users.bubble.ts` 對應 `/api/users`，`index` 則對應所在的資料夾
- Handler 接收標準的 `Request` 並回傳 `Response`，不需要架設 server 或使用 framework
- 每個 bubble 在各自的 worker 中執行

### Gateway

- 單一 gateway 在同一個 port 上服務所有 bubble，依路徑路由
- HTTP 與 WebSocket 都走同一個 gateway

### Web Console

- 可啟動、停止、路由與重啟 bubble，不需重啟 nibble 就能部署新版本
- Desired state 會被保存，nibble 重啟時自動還原

> [!WARNING]
> Bubble 沒有經過 sandbox 隔離。Bubble 在 nibble 自身的 process 中以相同的權限執行，可以讀取它的環境變數、檔案與 socket，請只執行可信任的 bubble。

## 快速開始

### 部署第一個 Bubble

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

Docker Compose：

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

1. 開啟 console `http://localhost:8081`，以 `admin` 登入後設定新密碼
2. 啟動 `hello` 並開啟路由
3. `curl "http://localhost:8080/hello?name=nibble"`

修改檔案後，在 console 重新部署，新版本的 worker running 後就會接手流量。

- Container 以 root 啟動，`nibbled` 會切換為掛載的 `bubbles` 資料夾的擁有者
- 該資料夾屬於 root 時，`nibbled` 改為切換成 `65532`（nonroot）
- 切換前，`nibbled` 會將資料與 socket 資料夾交給該使用者

### 從原始碼

需要 Bun 1.4、Go 1.27、`protoc`、[`protoc-gen-go`](https://pkg.go.dev/google.golang.org/protobuf/cmd/protoc-gen-go) 與 [`ts-proto`](https://github.com/stephenh/ts-proto)。

```bash
bun install
bun run proto
bun run build
./dist/nibbled
```

- `dist/` 內有 `nibbled`、engine `nibble` 與 gateway `nibble-router`，資料檔也放在同一個目錄
- 預設從 `dist/bubbles` 讀取 bubble，可用 `BUBBLE_SOURCE_DIR` 指定其他資料夾
- Console 監聽 `127.0.0.1:8081`，gateway 監聽 `127.0.0.1:8080`

---

## 開發

### 架構

```
nibbled (Go)                control plane：web console，desired state 存在 SQLite
└─ nibble (Bun)             engine：build snapshot、執行 bubble worker
   ├─ workers               每個執行中的 bubble 一個，各自監聽一個 Unix socket
   └─ nibble-router (Go)    gateway：將 HTTP 與 WebSocket 轉送到 socket
```

- Bubble 以常駐 worker 執行，因此沒有 cold start；每個 bubble 執行一個 worker，不支援 scale-to-zero 或自動擴展

| 目錄 | 內容 |
| :--- | :--- |
| `nibble-daemon` | `nibbled`、驗證與儲存；web console 在 `web/` |
| `nibble-engine` | Engine：snapshot 與 bubble worker |
| `nibble-router` | Gateway 與 protobuf schema `router.proto` |
| `nibble-sdk` | `@lucap9056/nibble`，bubble import 的套件 |
| `example` | 範例 bubble |
| `scripts` | Build script |
| `tests` | 整合測試 |

### 撰寫 Bubble

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

- **Handler**：`get`、`post`、`put`、`delete`、`patch`、`options`，以及包含 `upgrade`、`onconnect`、`onmessage`、`onclose` 的 `wss`
- **WebSocket context**：`upgrade` 回傳的值會成為 `ws.data`，回傳 `Response` 則拒絕連線；未定義時 `ws.data` 為帶有 UUIDv7 的 `{ connId }`
- **CORS**：`cors()` 會回應 preflight request，並檢查 WebSocket upgrade 的 `Origin`
- **入口檔**：`.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.jsx`、`.mjs`、`.cjs`
- **名稱**：每段路徑由英數字、`.`、`_`、`~`、`-` 組成
- **型別**：安裝 `@lucap9056/nibble` 取得 editor 型別，安裝 `@types/bun` 才有完整的 WebSocket 型別，否則為 `unknown`
- 所有 handler 的寫法見 [`example/bubbles/example.bubble.ts`](example/bubbles/example.bubble.ts)

### 路由

- 送往 bubble 路由底下的 request 會去掉 prefix 再轉給 bubble，prefix 放在 `X-Forwarded-Prefix`
- Bubble 可以先執行但不接流量，準備好之後再開啟路由

### Snapshot 與部署

- Snapshot 是打包後的 bubble source，以打包後程式碼的 SHA-256 命名，存放在 `BUBBLE_SNAPSHOT_DIR`
- 每個 bubble 可保留多個 snapshot，部署任一個即可更新或回滾
- 部署時未指定 snapshot，會從最新的 source build 一個
- 部署或重啟時會先啟動新的 worker，等它 running 後才切換流量，再停掉舊的 worker
- npm 套件不會被打包，執行時從安裝的位置載入，因此 `node_modules` 要保留在 source 旁邊

### 安裝依賴

`nibbled install`（或 `nibbled i`）以 engine 內建的 Bun 執行 `bun install`：

  Docker
```bash
docker exec nibble nibbled i signature --production
```
  Docker Compose
```bash
docker compose exec nibble nibbled i signature --production
```

- 路徑與 bubble 名稱一樣是相對於 `BUBBLE_SOURCE_DIR` 的路徑，例如 `signature`、`api/users`
- 必須位於該資料夾內、含有 `package.json`，且不能位於 `node_modules` 內
- 路徑之後的參數會原樣傳給 `bun install`
- 安裝與 `nibbled` 以相同使用者執行，安裝出的檔案會屬於 `bubbles` 資料夾的擁有者

### 宣告式部署

將 JSON array 透過 stdin 傳給 `nibbled`，啟動時會取代已保存的 desired state：

```bash
echo '[{ "name": "hello", "routing": true }]' | ./dist/nibbled
```

- 每個項目包含 `name`、`snapshotHash` 與 `routing`
- `snapshotHash` 為空時會 build 最新的 source
- 沒有 stdin 時，`nibbled` 會還原先前啟用的 bubble；無法再啟動的會改為停用

### 設定

| 環境變數 | 預設值 |
| :--- | :--- |
| `ADMIN_LISTEN` | `127.0.0.1:8081` |
| `ADMIN_PUBLIC_URL` | 未設定，見 [Console 驗證](#console-驗證) |
| `ADMIN_INITIAL_PASSWORD` | `admin` |
| `ADMIN_PASSWORD_FILE` | `nibbled` 旁的 `nibbled.passwd` |
| `ADMIN_JWT_SECRET_FILE` | `nibbled` 旁的 `nibbled.key`，首次啟動時產生 |
| `DATABASE_PATH` | `nibbled` 旁的 `nibble.db` |
| `ENGINE_BINARY` | `nibbled` 旁的 `nibble` |
| `REPORT_SOCKET` | `nibbled` 旁的 `nibbled.sock` |
| `CONTROL_SOCKET` | engine 旁的 `nibble.sock` |
| `ROUTER_LISTEN` | `127.0.0.1:8080` |
| `ROUTER_BINARY` | engine 旁的 `nibble-router` |
| `BUBBLE_SOURCE_DIR` | engine 旁的 `bubbles` |
| `BUBBLE_SNAPSHOT_DIR` | engine 旁的 `snapshots` |
| `BUBBLE_SOCKET_DIR` | engine 旁的 `sockets` |
| `LOG_LEVEL` | `info` |

所有變數都設定在 `nibbled` 上。

### Console 驗證

- 只有一組密碼；變更之前，`ADMIN_INITIAL_PASSWORD` 只能用來設定新密碼
  - 新密碼長度為 8 到 72 bytes，且不能與初始密碼相同
  - 變更密碼會登出所有 session
- 登入後 24 小時內有效
- 5 分鐘內登入失敗 5 次，最多會暫停登入 5 分鐘
- Console 只能透過 loopback 位址或 `ADMIN_PUBLIC_URL` 的 host 開啟；以網域提供 console 時需要設定

### Console 開發

Console 位於 `nibble-daemon/web`（Svelte 5、TypeScript、Vite），build 時會嵌入 `nibbled`。

```bash
docker compose -f docker-dev/docker-compose.yml up -d --build
cd nibble-daemon/web && bun install && bun run dev
```

- 開啟 Vite 顯示的網址；Vite 會將 request 轉送到 `NIBBLE_ADMIN_URL` 上的 `nibbled`（預設 `http://127.0.0.1:8081`）
- `docker-dev/` 會掛載 `example/bubbles`，以 `admin` 登入，log level 為 `debug`
- 以 `WEB=none`（`noweb` build tag）build，`nibbled` 不提供 console，頁面由 Vite 提供
- 不使用 Docker 時，可用 `bun run build:daemon --noweb` build 不含 console 的 `nibbled`

### SDK

```bash
bun run build:sdk
cd nibble-sdk/dist && npm publish --access public
```

- `nibble-sdk/dist` 是完整的套件，包含 ESM、CommonJS 以及兩者各自的型別宣告

### 測試

先執行 `bun run proto` 與 `bun run build:router`。

```bash
(cd nibble-engine && bun run test)
(cd nibble-router && go test ./...)
(cd nibble-daemon && go test ./...)
bun run test:integration
```

`test:integration` 會先 build `dist/`，再以 `example/bubbles` 啟動 `nibbled`，資料放在暫存資料夾。
