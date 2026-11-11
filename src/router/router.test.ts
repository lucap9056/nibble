import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import config from "@/config";
import { ControlMessage } from "./pb/router/router";
import { RouterProcess } from "./router";

const USER = "test-user";

const newRouter = () => new RouterProcess(config.routerBinaryPath);

const makeSocketDir = () => mkdtemp(path.join(os.tmpdir(), "nibble-router-"));

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
      const url = new URL(req.url);

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const user = req.headers.get("x-user");
        if (user === null) {
          return new Response("need user", {
            status: 401,
            headers: { "X-Reason": "no-user" },
          });
        }
        const offered = req.headers.get("sec-websocket-protocol") ?? "";
        server.upgrade(req, {
          data: { user, path: url.pathname },
          headers: offered.includes("chat")
            ? { "Sec-WebSocket-Protocol": "chat" }
            : undefined,
        });
        return undefined;
      }

      switch (url.pathname) {
        case "/echo":
          return new Response(req.body);
        case "/cookies": {
          const headers = new Headers({ "X-Custom": "yes" });
          headers.append("Set-Cookie", "a=1");
          headers.append("Set-Cookie", "b=2");
          return new Response("created", { status: 201, headers });
        }
        case "/gzip":
          return new Response(gzipSync("compressed-body"), {
            headers: { "Content-Encoding": "gzip" },
          });
        default:
          return Response.json({
            label,
            path: url.pathname,
            search: url.search,
            forwardedFor: req.headers.get("x-forwarded-for"),
            forwardedPrefix: req.headers.get("x-forwarded-prefix"),
          });
      }
    },
    websocket: {
      open(ws) {
        ws.send(`hello ${ws.data.user} at ${ws.data.path} from ${label}`);
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
    const socket = net.connect({ port, host: "127.0.0.1" }, () =>
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
  "Host: 127.0.0.1\r\n" +
  "Connection: Upgrade\r\n" +
  "Upgrade: websocket\r\n" +
  "Sec-WebSocket-Version: 13\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
  extraHeaders +
  "\r\n";

const countStatusLines = (response: string) =>
  response.match(/^HTTP\/1\.1 \d{3}/gm)?.length ?? 0;

const openWebSocket = (url: string, protocols?: string[]) => {
  const ws = new WebSocket(url, {
    headers: { "X-User": USER },
    protocols,
  } as unknown as string[]);
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

  const defaultRoutes = () => [
    { name: "alpha", socketPath: alpha.socketPath },
    { name: "missing", socketPath: path.join(socketDir, "missing.sock") },
  ];

  const fetchLabel = async (target: string) =>
    ((await (await fetch(`${baseUrl}${target}`)).json()) as { label: string })
      .label;

  beforeAll(async () => {
    socketDir = await makeSocketDir();
    alpha = startFakeBubble(path.join(socketDir, "alpha.sock"), "alpha");
    beta = startFakeBubble(path.join(socketDir, "beta.sock"), "beta");

    router = newRouter();
    port = await router.start("127.0.0.1:0", defaultRoutes());
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await router.stop(true);
    alpha.server.stop(true);
    beta.server.stop(true);
    await rm(socketDir, { recursive: true, force: true });
  });

  describe("HTTP", () => {
    test("strips the prefix, keeps the query and overrides forwarded headers", async () => {
      const res = await fetch(`${baseUrl}/alpha/users/1?x=1`, {
        headers: { "X-Forwarded-For": "6.6.6.6" },
      });
      expect(await res.json()).toMatchObject({
        path: "/users/1",
        search: "?x=1",
        forwardedFor: "127.0.0.1",
        forwardedPrefix: "/alpha",
      });
    });

    test("streams bodies and preserves status and headers verbatim", async () => {
      const payload = crypto.getRandomValues(new Uint8Array(1024 * 1024));
      const echo = await fetch(`${baseUrl}/alpha/echo`, {
        method: "POST",
        body: payload,
      });
      expect(new Uint8Array(await echo.arrayBuffer())).toEqual(payload);

      const cookies = await fetch(`${baseUrl}/alpha/cookies`);
      expect(cookies.status).toBe(201);
      expect(cookies.headers.get("x-custom")).toBe("yes");
      expect(cookies.headers.getSetCookie()).toEqual(["a=1", "b=2"]);

      const gzip = await fetch(`${baseUrl}/alpha/gzip`, { decompress: false });
      expect(gzip.headers.get("content-encoding")).toBe("gzip");
      expect(new Uint8Array(await gzip.arrayBuffer())).toEqual(
        new Uint8Array(gzipSync("compressed-body")),
      );
    });

    test.each([
      ["/alphabet", 404, "Not Found"],
      ["/missing/x", 502, "Bad Gateway"],
    ])("%s responds %d", async (target, status, error) => {
      const res = await fetch(`${baseUrl}${target}`);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    });
  });

  describe("WebSocket", () => {
    test("tunnels messages, subprotocol and client close", async () => {
      const session = openWebSocket(`ws://127.0.0.1:${port}/alpha/chat`, [
        "superchat",
        "chat",
      ]);
      await session.opened;
      expect(session.ws.protocol).toBe("chat");
      expect(await session.next()).toBe(`hello ${USER} at /chat from alpha`);

      session.ws.send("ping");
      expect(await session.next()).toBe("ping");

      session.ws.close(4321, "client-bye");
      await session.closed;
      await Bun.sleep(50);
      expect(alpha.closes).toContainEqual([4321, "client-bye"]);
    });

    test("propagates close initiated by the bubble", async () => {
      const session = openWebSocket(`ws://127.0.0.1:${port}/alpha/ws`);
      await session.next();
      session.ws.send("close-me");
      expect(await session.closed).toEqual([4001, "server-bye"]);
    });

    test("returns a rejected upgrade verbatim and closes without forwarding pipelined bytes", async () => {
      const { response, closed } = await rawRequest(
        port,
        `${upgradeRequest("/alpha/ws")}GET /alpha/pipelined HTTP/1.1\r\nHost: x\r\n\r\n`,
      );
      expect(response.startsWith("HTTP/1.1 401")).toBe(true);
      expect(response).toMatch(/x-reason: no-user/i);
      expect(response.endsWith("need user")).toBe(true);
      expect(countStatusLines(response)).toBe(1);
      expect(closed).toBe(true);
    });

    test("returns 502 and closes the connection when the bubble is unreachable", async () => {
      const { response, closed } = await rawRequest(
        port,
        upgradeRequest("/missing/ws", `X-User: ${USER}\r\n`),
      );
      expect(response.startsWith("HTTP/1.1 502 Bad Gateway")).toBe(true);
      expect(closed).toBe(true);
    });
  });

  describe("setRoutes", () => {
    test("swaps the route table", async () => {
      await router.setRoutes([{ name: "alpha", socketPath: beta.socketPath }]);
      expect(await fetchLabel("/alpha")).toBe("beta");
      expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);

      await router.setRoutes(defaultRoutes());
      expect(await fetchLabel("/alpha")).toBe("alpha");
    });
  });
});

describe("RouterProcess lifecycle", () => {
  test("rejects start and exited with the same error when the port is in use", async () => {
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const router = newRouter();
    const startError = await router
      .start(`127.0.0.1:${occupied.port}`)
      .catch((err: Error) => err);
    expect(startError).toBeInstanceOf(Error);
    await expect(router.exited).rejects.toBe(startError as Error);
    occupied.stop(true);
  });

  test("graceful stop releases the port and resolves exited", async () => {
    const router = newRouter();
    const port = await router.start("127.0.0.1:0");
    await router.stop();
    await router.exited;
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow();
  });

  test("force stop closes open tunnels", async () => {
    const socketDir = await makeSocketDir();
    const bubble = startFakeBubble(path.join(socketDir, "b.sock"), "b");
    const router = newRouter();
    const port = await router.start("127.0.0.1:0", [
      { name: "b", socketPath: bubble.socketPath },
    ]);

    const session = openWebSocket(`ws://127.0.0.1:${port}/b`);
    await session.opened;
    await router.stop(true);
    const [code] = await session.closed;
    expect(code).not.toBe(1000);

    bubble.server.stop(true);
    await rm(socketDir, { recursive: true, force: true });
  });

  test("rejects setRoutes while stopping and after exit", async () => {
    const router = newRouter();
    await router.start("127.0.0.1:0");

    const stopping = router.stop();
    await expect(router.setRoutes([])).rejects.toThrow("stopping");
    await stopping;
    await expect(router.setRoutes([])).rejects.toThrow("exited");
  });

  test("repeated stop sends a single close and waits for exit", async () => {
    const router = newRouter();
    const { stdin } = (router as unknown as { child: Bun.Subprocess<"pipe"> })
      .child;
    const write = spyOn(stdin, "write");
    await router.start("127.0.0.1:0");

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
      return ControlMessage.decode(reader, reader.uint32()).command?.$case;
    });
    expect(commands).toEqual(["startup", "close"]);
  });
});
