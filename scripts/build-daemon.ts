import path from "node:path";

export const DAEMON_BINARY_NAME =
  process.platform === "win32" ? "nibbled.exe" : "nibbled";

const rootPath = path.resolve(import.meta.dir, "..");
const daemonModulePath = path.join(rootPath, "nibble-daemon");
const webPath = path.join(daemonModulePath, "web");

const run = (command: string[], cwd: string) => {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) {
    const commandText = command.join(" ");
    throw new Error(`${commandText} failed with exit code ${result.exitCode}`);
  }
};

export const buildDaemon = (outfile: string) => {
  run(["bun", "install", "--frozen-lockfile"], webPath);
  run(["bun", "run", "build"], webPath);
  run(
    ["go", "build", "-trimpath", "-o", outfile, "./cmd/nibbled"],
    daemonModulePath,
  );
  return outfile;
};

if (import.meta.main) {
  console.log(
    buildDaemon(path.join(daemonModulePath, "bin", DAEMON_BINARY_NAME)),
  );
}
