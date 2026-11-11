import path from "node:path";

export interface Config {
  bubbleSourceDir: string;
  bubbleSocketDir: string;
  databasePath: string;
}

const rootPath = Bun.isStandaloneExecutable
  ? path.dirname(process.execPath)
  : path.resolve(import.meta.dir, "../..");

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
};

export default config;
