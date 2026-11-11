import path from "node:path";

export interface Config {
  bubbleSourceDir: string;
  bubbleSocketDir: string;
  databasePath: string;
  routerBinaryPath: string;
}

export const ROUTER_BINARY_NAME =
  process.platform === "win32" ? "nibble-router.exe" : "nibble-router";

const rootPath = Bun.isStandaloneExecutable
  ? path.dirname(process.execPath)
  : path.resolve(import.meta.dir, "../..");

const defaultRouterBinaryPath = Bun.isStandaloneExecutable
  ? path.join(rootPath, ROUTER_BINARY_NAME)
  : path.join(rootPath, "router/bin", ROUTER_BINARY_NAME);

const config: Config = {
  bubbleSourceDir: path.resolve(
    Bun.env.BUBBLE_SOURCE_DIR ?? path.join(rootPath, "bubbles"),
  ),
  bubbleSocketDir: path.resolve(
    Bun.env.BUBBLE_SOCKET_DIR ?? path.join(rootPath, "sockets"),
  ),
  databasePath: path.resolve(
    Bun.env.DATABASE ?? path.join(rootPath, "bubbles.db"),
  ),
  routerBinaryPath: path.resolve(
    Bun.env.ROUTER_BINARY ?? defaultRouterBinaryPath,
  ),
};

export default config;
