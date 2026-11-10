import path from "node:path";

const rootPath = path.resolve(import.meta.dir, "..");
const srcPath = path.join(rootPath, "src");

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
