import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import config from "@/config";
import type { RouteEntry } from "./pb";
import { ControlMessage } from "./pb/router/router";
import { RouterProcess } from "./router";

const USER = "test-user";
const HOST = "127.0.0.1";
const LISTEN = `${HOST}:0`;
const GZIP_BODY = "compressed-body";
const TMP_DIR = os.tmpdir();
const SOCKET_DIR_PREFIX = path.join(TMP_DIR, "nibble-router-");
const { routerBinaryPath } = config;

interface FakeBubble {
  socketPath: string;
  server: Bun.Server<{ user: string; path: string }>;
  closes: [number, string][];
}

const startFakeBubble = (socketPath: string, label: string): FakeBubble => {
  const closes: [number, string][] = [];
  const server = Bun.serve<{ user: string; path: string }>({
    unix: socketPath,
    fetch(req, server) {
      const { pathname, search } = new URL(req.url);

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const user = req.headers.get("x-user");
        if (user === null) {
          return new Response("need user", {
            status: 401,
            headers: { "X-Reason": "no-user" },
          });
        }
        const offered = req.headers.get("sec-websocket-protocol") ?? "";
        const headers = offered.includes("chat")
          ? { "Sec-WebSocket-Protocol": "chat" }
          : undefined;
        server.upgrade(req, { data: { user, path: pathname }, headers });
        return undefined;
      }

      switch (pathname) {
        case "/echo":
          return new Response(req.body);
        case "/cookies": {
          const headers = new Headers({ "X-Custom": "yes" });
          headers.append("Set-Cookie", "a=1");
          headers.append("Set-Cookie", "b=2");
          return new Response("created", { status: 201, headers });
        }
        case "/gzip": {
          const body = gzipSync(GZIP_BODY);
          return new Response(body, {
            headers: { "Content-Encoding": "gzip" },
          });
        }
        default: {
          const forwardedFor = req.headers.get("x-forwarded-for");
          const forwardedPrefix = req.headers.get("x-forwarded-prefix");
          return Response.json({
            label,
            path: pathname,
            search,
            forwardedFor,
            forwardedPrefix,
          });
        }
      }
    },
    websocket: {
      open(ws) {
        const greeting = `hello ${ws.data.user} at ${ws.data.path} from ${label}`;
        ws.send(greeting);
      },
      message(ws, message) {
        if (message === "close-me") {
          ws.close(4001, "server-bye");
        } else {
          ws.send(message);
        }
      },
      close(_ws, code, reason) {
        closes.push([code, reason]);
      },
    },
  });
  return { socketPath, server, closes };
};

const rawRequest = (port: number, request: string) =>
  new Promise<{ response: string; closed: boolean }>((resolve) => {
    let response = "";
    const socket = net.connect({ port, host: HOST }, () =>
      socket.write(request),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("close", () => resolve({ response, closed: true }));
    socket.on("error", () => {});
    setTimeout(() => {
      socket.destroy();
      resolve({ response, closed: false });
    }, 2000);
  });

const upgradeRequest = (target: string, extraHeaders = "") =>
  `GET ${target} HTTP/1.1\r\n` +
  `Host: ${HOST}\r\n` +
  "Connection: Upgrade\r\n" +
  "Upgrade: websocket\r\n" +
  "Sec-WebSocket-Version: 13\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
  extraHeaders +
  "\r\n";

const openWebSocket = (url: string, protocols?: string[]) => {
  const options = { headers: { "X-User": USER }, protocols };
  const ws = new WebSocket(url, options as unknown as string[]);
  const inbox: string[] = [];
  const waiters: ((message: string) => void)[] = [];
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<[number, string]>();

  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.reject(new Error("WebSocket error"));
  ws.onmessage = (e) => {
    const message = String(e.data);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  };
  ws.onclose = (e) => closed.resolve([e.code, e.reason]);

  const next = () => {
    const queued = inbox.shift();
    return queued !== undefined
      ? Promise.resolve(queued)
      : new Promise<string>((resolve) => waiters.push(resolve));
  };

  return { ws, opened: opened.promise, closed: closed.promise, next };
};

describe("RouterProcess proxy", () => {
  let socketDir: string;
  let alpha: FakeBubble;
  let beta: FakeBubble;
  let router: RouterProcess;
  let port: number;
  let baseUrl: string;
  let wsBaseUrl: string;
  let defaultRoutes: RouteEntry[];

  beforeAll(async () => {
    socketDir = await mkdtemp(SOCKET_DIR_PREFIX);
    const alphaSocketPath = path.join(socketDir, "alpha.sock");
    const betaSocketPath = path.join(socketDir, "beta.sock");
    const missingSocketPath = path.join(socketDir, "missing.sock");
    alpha = startFakeBubble(alphaSocketPath, "alpha");
    beta = startFakeBubble(betaSocketPath, "beta");
    defaultRoutes = [
      { routePath: "/alpha/", socketPath: alphaSocketPath },
      { routePath: "/alpha/nested/", socketPath: betaSocketPath },
      { routePath: "/missing/", socketPath: missingSocketPath },
    ];

    router = new RouterProcess(routerBinaryPath);
    await router.setRoutes(defaultRoutes);
    port = await router.start(LISTEN);
    baseUrl = `http://${HOST}:${port}`;
    wsBaseUrl = `ws://${HOST}:${port}`;
  });

  afterAll(async () => {
    await router.stop(true);
    alpha.server.stop(true);
    beta.server.stop(true);
    await rm(socketDir, { recursive: true, force: true });
  });

  describe("HTTP", () => {
    test("strips the prefix, keeps the query and overrides forwarded headers", async () => {
      const url = `${baseUrl}/alpha/users/1?x=1`;
      const res = await fetch(url, {
        headers: { "X-Forwarded-For": "6.6.6.6" },
      });
      const body = await res.json();
      expect(body).toMatchObject({
        label: "alpha",
        path: "/users/1",
        search: "?x=1",
        forwardedFor: HOST,
        forwardedPrefix: "/alpha",
      });
    });

    test("routes to the longest matching path", async () => {
      const url = `${baseUrl}/alpha/nested/x`;
      const res = await fetch(url);
      const body = await res.json();
      expect(body).toMatchObject({
        label: "beta",
        path: "/x",
        forwardedPrefix: "/alpha/nested",
      });
    });

    test("streams bodies and preserves status and headers verbatim", async () => {
      const payloadBuffer = new Uint8Array(1024 * 1024);
      const payload = crypto.getRandomValues(payloadBuffer);
      const echoUrl = `${baseUrl}/alpha/echo`;
      const echo = await fetch(echoUrl, { method: "POST", body: payload });
      const echoed = await echo.bytes();
      expect(echoed).toEqual(payload);

      const cookiesUrl = `${baseUrl}/alpha/cookies`;
      const cookies = await fetch(cookiesUrl);
      const customHeader = cookies.headers.get("x-custom");
      const setCookies = cookies.headers.getSetCookie();
      expect(cookies.status).toBe(201);
      expect(customHeader).toBe("yes");
      expect(setCookies).toEqual(["a=1", "b=2"]);

      const gzipUrl = `${baseUrl}/alpha/gzip`;
      const gzip = await fetch(gzipUrl, { decompress: false });
      const compressed = await gzip.bytes();
      const contentEncoding = gzip.headers.get("content-encoding");
      const gzipped = gzipSync(GZIP_BODY);
      const expected = new Uint8Array(gzipped);
      expect(contentEncoding).toBe("gzip");
      expect(compressed).toEqual(expected);
    });

    test.each([
      ["/alphabet", 404, "Not Found"],
      ["/missing/x", 502, "Bad Gateway"],
    ])("%s responds %d", async (target, status, error) => {
      const url = `${baseUrl}${target}`;
      const res = await fetch(url);
      const body = await res.json();
      expect(res.status).toBe(status);
      expect(body).toEqual({ error });
    });
  });

  describe("WebSocket", () => {
    test("tunnels messages, subprotocol and client close", async () => {
      const url = `${wsBaseUrl}/alpha/chat`;
      const protocols = ["superchat", "chat"];
      const session = openWebSocket(url, protocols);
      await session.opened;
      const greeting = await session.next();
      expect(session.ws.protocol).toBe("chat");
      expect(greeting).toBe(`hello ${USER} at /chat from alpha`);

      session.ws.send("ping");
      const echoed = await session.next();
      expect(echoed).toBe("ping");

      session.ws.close(4321, "client-bye");
      await session.closed;
      await Bun.sleep(50);
      expect(alpha.closes).toContainEqual([4321, "client-bye"]);
    });

    test("propagates close initiated by the bubble", async () => {
      const url = `${wsBaseUrl}/alpha/ws`;
      const session = openWebSocket(url);
      await session.next();
      session.ws.send("close-me");
      expect(await session.closed).toEqual([4001, "server-bye"]);
    });

    test("returns a rejected upgrade verbatim and closes without forwarding pipelined bytes", async () => {
      const upgrade = upgradeRequest("/alpha/ws");
      const pipelined = "GET /alpha/pipelined HTTP/1.1\r\nHost: x\r\n\r\n";
      const request = `${upgrade}${pipelined}`;
      const { response, closed } = await rawRequest(port, request);
      const statusLines = response.match(/^HTTP\/1\.1 \d{3}/gm) ?? [];
      expect(response).toStartWith("HTTP/1.1 401");
      expect(response).toMatch(/x-reason: no-user/i);
      expect(response).toEndWith("need user");
      expect(statusLines).toHaveLength(1);
      expect(closed).toBe(true);
    });

    test("returns 502 and closes the connection when the bubble is unreachable", async () => {
      const userHeader = `X-User: ${USER}\r\n`;
      const request = upgradeRequest("/missing/ws", userHeader);
      const { response, closed } = await rawRequest(port, request);
      expect(response).toStartWith("HTTP/1.1 502 Bad Gateway");
      expect(closed).toBe(true);
    });
  });

  describe("setRoutes", () => {
    test("swaps the route table", async () => {
      const alphaUrl = `${baseUrl}/alpha`;
      const missingUrl = `${baseUrl}/missing`;
      const swappedRoutes = [
        { routePath: "/alpha/", socketPath: beta.socketPath },
      ];

      await router.setRoutes(swappedRoutes);
      const swapped = await fetch(alphaUrl);
      const removed = await fetch(missingUrl);
      const swappedBody = await swapped.json();
      expect(swappedBody).toMatchObject({ label: "beta" });
      expect(removed.status).toBe(404);

      await router.setRoutes(defaultRoutes);
      const restored = await fetch(alphaUrl);
      const restoredBody = await restored.json();
      expect(restoredBody).toMatchObject({ label: "alpha" });
    });
  });
});

describe("RouterProcess lifecycle", () => {
  test("rejects start and exited with the same error when the port is in use", async () => {
    const occupied = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch: () => new Response(),
    });
    const occupiedListen = `${HOST}:${occupied.port}`;
    const router = new RouterProcess(routerBinaryPath);
    const startError = await router
      .start(occupiedListen)
      .catch((err: Error) => err);
    expect(startError).toBeInstanceOf(Error);
    await expect(router.exited).rejects.toBe(startError as Error);
    occupied.stop(true);
  });

  test("stop before start resolves exited", async () => {
    const router = new RouterProcess(routerBinaryPath);
    await router.stop();
    await expect(router.exited).resolves.toBeUndefined();
  });

  test("graceful stop releases the port and resolves exited", async () => {
    const router = new RouterProcess(routerBinaryPath);
    const port = await router.start(LISTEN);
    const url = `http://${HOST}:${port}/x`;
    await router.stop();
    await router.exited;
    const fetching = fetch(url);
    await expect(fetching).rejects.toThrow();
  });

  test("force stop closes open tunnels", async () => {
    const socketDir = await mkdtemp(SOCKET_DIR_PREFIX);
    const socketPath = path.join(socketDir, "b.sock");
    const bubble = startFakeBubble(socketPath, "b");
    const routes = [{ routePath: "/b/", socketPath }];
    const router = new RouterProcess(routerBinaryPath);
    const port = await router.start(LISTEN, routes);

    const url = `ws://${HOST}:${port}/b`;
    const session = openWebSocket(url);
    await session.opened;
    await router.stop(true);
    const [code] = await session.closed;
    expect(code).not.toBe(1000);

    bubble.server.stop(true);
    await rm(socketDir, { recursive: true, force: true });
  });

  test("rejects setRoutes while stopping and after exit", async () => {
    const router = new RouterProcess(routerBinaryPath);
    await router.start(LISTEN);

    const stopping = router.stop();
    const settingWhileStopping = router.setRoutes([]);
    await expect(settingWhileStopping).rejects.toThrow("stopping");
    await stopping;
    const settingAfterExit = router.setRoutes([]);
    await expect(settingAfterExit).rejects.toThrow("exited");
  });

  test("repeated stop sends a single close and waits for exit", async () => {
    const router = new RouterProcess(routerBinaryPath);
    const { child } = router as unknown as { child: Bun.Subprocess<"pipe"> };
    const write = spyOn(child.stdin, "write");
    await router.start(LISTEN);

    let hasExited = false;
    router.exited.then(() => {
      hasExited = true;
    });

    const first = router.stop();
    await router.stop();
    expect(hasExited).toBe(true);
    await first;

    const commands = write.mock.calls.map(([chunk]) => {
      const reader = new BinaryReader(chunk as Uint8Array);
      const length = reader.uint32();
      return ControlMessage.decode(reader, length).command?.$case;
    });
    expect(commands).toEqual(["startup", "close"]);
  });
});
