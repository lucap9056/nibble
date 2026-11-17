import path from "node:path";

const rootPath = path.resolve(import.meta.dir, "..");
const srcPath = path.join(rootPath, "nibble-engine", "src");
const mainEntryPath = path.join(srcPath, "main.ts");
const workerEntryPath = path.join(srcPath, "bubble.worker.ts");

export const buildEngine = async (outfile: string) => {
  const result = await Bun.build({
    entrypoints: [mainEntryPath, workerEntryPath],
    files: {
      [workerEntryPath]: `import "./bubbles/bubble.worker.ts";`,
    },
    root: srcPath,
    compile: {
      outfile,
      autoloadPackageJson: true,
    },
  });
  if (!result.success) {
    const messages = result.logs.map(String).join("\n");
    throw new Error(`engine build failed:\n${messages}`);
  }
  return result.outputs.map((output) => output.path);
};

if (import.meta.main) {
  const outfile = path.join(rootPath, "dist", "nibble");
  const outputs = await buildEngine(outfile);
  console.log(outputs.join("\n"));
}
