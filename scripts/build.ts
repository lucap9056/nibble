import path from "node:path";
import { ROUTER_BINARY_NAME } from "@lucap9056/nibble-engine/config";
import { buildRouter } from "./build-router";

const rootPath = path.resolve(import.meta.dir, "..");
const enginePath = path.join(rootPath, "nibble-engine");
const srcPath = path.join(enginePath, "src");

const workerEntryPath = path.join(srcPath, "bubble.worker.ts");

const result = await Bun.build({
  entrypoints: [path.join(srcPath, "main.ts"), workerEntryPath],
  files: {
    [workerEntryPath]: `import "./bubbles/bubble.worker.ts";`,
  },
  root: srcPath,
  compile: {
    outfile: path.join(rootPath, "dist/nibble"),
    autoloadPackageJson: true,
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(output.path);
}

console.log(buildRouter(path.join(rootPath, "dist", ROUTER_BINARY_NAME)));
