import path from "node:path";
import { ROUTER_BINARY_NAME } from "@lucap9056/nibble-engine/config";

const rootPath = path.resolve(import.meta.dir, "..");
const routerModulePath = path.join(rootPath, "nibble-router");

export const buildRouter = (outfile: string) => {
  const result = Bun.spawnSync(
    ["go", "build", "-trimpath", "-o", outfile, "./cmd/router"],
    { cwd: routerModulePath, stdout: "inherit", stderr: "inherit" },
  );
  if (!result.success) {
    throw new Error(`go build failed with exit code ${result.exitCode}`);
  }
  return outfile;
};

if (import.meta.main) {
  console.log(
    buildRouter(path.join(routerModulePath, "bin", ROUTER_BINARY_NAME)),
  );
}
