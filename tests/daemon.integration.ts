import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const executableSuffix = process.platform === "win32" ? ".exe" : "";
const rootPath = path.resolve(import.meta.dir, "..");
const distPath = path.join(rootPath, "dist");
const daemonBinary = path.join(distPath, `nibbled${executableSuffix}`);
const engineBinary = path.join(distPath, `nibble${executableSuffix}`);
const sourceDir = path.join(rootPath, "example", "bubbles");

const STARTUP_TIMEOUT_MS = 120_000;
const INITIAL_PASSWORD = "admin";
const NEW_PASSWORD = "correct horse battery";

// biome-ignore-start lint/style/useNamingConvention: environment variable names are uppercase by convention
const TEMP_PATH_ENV = {
  ADMIN_JWT_SECRET_FILE: "nibbled.key",
  ADMIN_PASSWORD_FILE: "nibbled.passwd",
  DATABASE_PATH: "nibble.db",
  CONTROL_SOCKET: "control.sock",
  REPORT_SOCKET: "report.sock",
  BUBBLE_SNAPSHOT_DIR: "snapshots",
  BUBBLE_SOCKET_DIR: "sockets",
};
// biome-ignore-end lint/style/useNamingConvention: environment variable names are uppercase by convention

interface BubbleView {
  name: string;
  running: { state: string } | null;
  desired: { enabled: boolean; routing: boolean } | null;
}

const freePort = () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port;
};

const waitFor = async (check: () => Promise<boolean>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const passed = await check().catch(() => false);
    if (passed) return;
    await Bun.sleep(200);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
};

describe("nibbled", () => {
  let tempDir = "";
  let adminUrl = "";
  let routerUrl = "";
  let daemon: Bun.Subprocess | undefined;
  let launchCount = 0;
  let token = "";

  const startDaemon = async (seed?: unknown[]) => {
    launchCount += 1;
    const logPath = path.join(tempDir, `daemon-${launchCount}.log`);
    const seedText = JSON.stringify(seed);
    const stdin = seed === undefined ? "ignore" : new Blob([seedText]);
    const { host: adminHost } = new URL(adminUrl);
    const { host: routerHost } = new URL(routerUrl);
    const stderr = Bun.file(logPath);
    const tempEntries = Object.entries(TEMP_PATH_ENV).map(([key, name]) => [
      key,
      path.join(tempDir, name),
    ]);
    const tempPaths = Object.fromEntries(tempEntries);
    const child = Bun.spawn([daemonBinary], {
      stdin,
      stdout: "ignore",
      stderr,
      // biome-ignore-start lint/style/useNamingConvention: environment variable names are uppercase by convention
      env: {
        ...Bun.env,
        ...tempPaths,
        ADMIN_LISTEN: adminHost,
        ADMIN_PUBLIC_URL: "",
        ADMIN_INITIAL_PASSWORD: INITIAL_PASSWORD,
        ENGINE_BINARY: engineBinary,
        BUBBLE_SOURCE_DIR: sourceDir,
        ROUTER_LISTEN: routerHost,
      },
      // biome-ignore-end lint/style/useNamingConvention: environment variable names are uppercase by convention
    });

    const adminReady = async () => {
      if (child.exitCode !== null) {
        const log = await stderr.text();
        throw new Error(`daemon exited with ${child.exitCode}:\n${log}`);
      }
      const response = await fetch(`${adminUrl}/api/bubbles`);
      return response.status === 401;
    };
    await waitFor(adminReady, STARTUP_TIMEOUT_MS);
    return child;
  };

  const stopDaemon = async () => {
    if (daemon === undefined) return;
    daemon.kill();
    await daemon.exited;
    daemon = undefined;
    const routerClosed = () =>
      fetch(routerUrl).then(
        () => false,
        () => true,
      );
    await waitFor(routerClosed, STARTUP_TIMEOUT_MS);
  };

  const admin = (method: string, apiPath: string, body?: unknown) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token !== "") {
      headers.Authorization = `Bearer ${token}`;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return fetch(`${adminUrl}${apiPath}`, { method, headers, body: payload });
  };

  const listBubbles = async () => {
    const response = await admin("GET", "/api/bubbles");
    expect(response.status).toBe(200);
    const { bubbles } = (await response.json()) as { bubbles: BubbleView[] };
    return bubbles;
  };

  beforeAll(async () => {
    const tempPrefix = path.join(tmpdir(), "nibble-");
    tempDir = await mkdtemp(tempPrefix);
    const adminPort = freePort();
    const routerPort = freePort();
    adminUrl = `http://127.0.0.1:${adminPort}`;
    routerUrl = `http://127.0.0.1:${routerPort}`;
    daemon = await startDaemon([
      { name: "example", routing: true },
      { name: "example", routing: false },
      { name: "missing", routing: true },
    ]);
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await stopDaemon();
    await rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }, STARTUP_TIMEOUT_MS);

  test("requires a password change before the first login", async () => {
    const initialLogin = await admin("POST", "/api/login", {
      password: INITIAL_PASSWORD,
    });
    expect(initialLogin.status).toBe(403);

    const change = await admin("PUT", "/api/password", {
      currentPassword: INITIAL_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(change.status).toBe(204);

    const login = await admin("POST", "/api/login", {
      password: NEW_PASSWORD,
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as { token: string };
    token = session.token;
  });

  test("keeps only accepted seed bubbles", async () => {
    const bubbles = await listBubbles();
    const names = bubbles.map(({ name }) => name);
    expect(names).not.toContain("missing");

    const example = bubbles.find(({ name }) => name === "example");
    expect(example?.running?.state).toBe("running");
    expect(example?.desired).toMatchObject({ enabled: true, routing: true });
  });

  test("routes requests to the running bubble without its prefix", async () => {
    const response = await fetch(`${routerUrl}/example/hello`);
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const { pathname } = new URL(url);
    expect(pathname).toBe("/hello");
  });

  test(
    "restores credentials and bubbles after restart",
    async () => {
      await stopDaemon();
      daemon = await startDaemon();

      const bubbles = await listBubbles();
      const example = bubbles.find(({ name }) => name === "example");
      expect(example?.running?.state).toBe("running");
    },
    STARTUP_TIMEOUT_MS,
  );
});
