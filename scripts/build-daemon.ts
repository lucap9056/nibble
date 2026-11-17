import path from "node:path";

export const DAEMON_BINARY_NAME =
  process.platform === "win32" ? "nibbled.exe" : "nibbled";

const rootPath = path.resolve(import.meta.dir, "..");
const daemonModulePath = path.join(rootPath, "nibble-daemon");

export const buildDaemon = (outfile: string) => {
  const result = Bun.spawnSync(
    ["go", "build", "-trimpath", "-o", outfile, "./cmd/nibbled"],
    { cwd: daemonModulePath, stdout: "inherit", stderr: "inherit" },
  );
  if (!result.success) {
    throw new Error(`go build failed with exit code ${result.exitCode}`);
  }
  return outfile;
};

if (import.meta.main) {
  console.log(
    buildDaemon(path.join(daemonModulePath, "bin", DAEMON_BINARY_NAME)),
  );
}
