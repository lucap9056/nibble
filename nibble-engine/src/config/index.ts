import path from "node:path";

export interface Config {
  bubbleSourceDir: string;
  bubbleSocketDir: string;
  bubbleSnapshotDir: string;
  routerBinaryPath: string;
  routerListen: string;
  controlSocketPath: string;
}

export const ROUTER_BINARY_NAME =
  process.platform === "win32" ? "nibble-router.exe" : "nibble-router";

const rootPath = Bun.isStandaloneExecutable
  ? path.dirname(process.execPath)
  : path.resolve(import.meta.dir, "../../..");

const defaultRouterBinaryPath = Bun.isStandaloneExecutable
  ? path.join(rootPath, ROUTER_BINARY_NAME)
  : path.join(rootPath, "nibble-router/bin", ROUTER_BINARY_NAME);

const config: Config = {
  bubbleSourceDir: path.resolve(
    Bun.env.BUBBLE_SOURCE_DIR ?? path.join(rootPath, "bubbles"),
  ),
  bubbleSocketDir: path.resolve(
    Bun.env.BUBBLE_SOCKET_DIR ?? path.join(rootPath, "sockets"),
  ),
  bubbleSnapshotDir: path.resolve(
    Bun.env.BUBBLE_SNAPSHOT_DIR ?? path.join(rootPath, "snapshots"),
  ),
  routerBinaryPath: path.resolve(
    Bun.env.ROUTER_BINARY ?? defaultRouterBinaryPath,
  ),
  routerListen: Bun.env.ROUTER_LISTEN ?? "127.0.0.1:8080",
  controlSocketPath: path.resolve(
    Bun.env.CONTROL_SOCKET ?? path.join(rootPath, "nibble.sock"),
  ),
};

export default config;
