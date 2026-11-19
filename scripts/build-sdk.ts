import { copyFile, rm } from "node:fs/promises";
import path from "node:path";

const rootPath = path.resolve(import.meta.dir, "..");
const sdkPath = path.join(rootPath, "nibble-sdk");
const srcPath = path.join(sdkPath, "src");
const licensePath = path.join(rootPath, "LICENSE");

interface SdkManifest {
  name: string;
  version: string;
  license: string;
  exports: Record<string, string>;
}

const manifestPath = path.join(sdkPath, "package.json");
const manifest = (await Bun.file(manifestPath).json()) as SdkManifest;
const entries = Object.entries(manifest.exports);

const toDist = (source: string, extension: string) =>
  source.replace(/^\.\/src\//, "./").replace(/\.ts$/, extension);

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, {
    cwd: rootPath,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) {
    const commandText = command.join(" ");
    throw new Error(`${commandText} failed with exit code ${result.exitCode}`);
  }
};

const buildModules = async (
  outdir: string,
  format: "esm" | "cjs",
  extension: string,
) => {
  const entrypoints = entries.map(([, source]) => path.join(sdkPath, source));
  const result = await Bun.build({
    entrypoints,
    root: srcPath,
    outdir,
    format,
    // target "bun" wraps cjs output in a Bun-only loader, "node" keeps it portable
    target: "node",
    external: [manifest.name],
    naming: `[dir]/[name]${extension}`,
  });
  if (!result.success) {
    const messages = result.logs.map(String).join("\n");
    throw new Error(`sdk ${format} build failed:\n${messages}`);
  }
  return result.outputs.map((output) => output.path);
};

// node16/nodenext resolution rejects extensionless relative imports in declarations
const withExtension = (declaration: string, extension: string) =>
  declaration.replace(
    /(from\s+|import\s*\(\s*)(["'])(\.\.?\/[^"']+?)\2/g,
    (_, prefix, quote, specifier) =>
      `${prefix}${quote}${specifier}${extension}${quote}`,
  );

const buildDeclarations = async (outdir: string) => {
  const tsconfigPath = path.join(sdkPath, "tsconfig.json");
  run([
    "bun",
    "x",
    "tsc",
    "-p",
    tsconfigPath,
    "--noEmit",
    "false",
    "--declaration",
    "--emitDeclarationOnly",
    "--rootDir",
    srcPath,
    "--composite",
    "false",
    "--incremental",
    "false",
    "--outDir",
    outdir,
  ]);

  const outputs: string[] = [];
  const emittedGlob = new Bun.Glob("**/*.d.ts");
  for await (const relativePath of emittedGlob.scan(outdir)) {
    const esmPath = path.join(outdir, relativePath);
    const cjsPath = esmPath.replace(/\.d\.ts$/, ".d.cts");
    const sourcePath = path.join(
      srcPath,
      relativePath.replace(/\.d\.ts$/, ".ts"),
    );
    const source = await Bun.file(sourcePath).text();
    // tsc drops reference path directives from emitted declarations
    const references = source.match(/^\/\/\/ <reference path=.*$/gm) ?? [];
    const header = references.map((reference) => `${reference}\n`).join("");
    const declaration = await Bun.file(esmPath).text();
    await Bun.write(esmPath, header + withExtension(declaration, ".js"));
    await Bun.write(cjsPath, header + withExtension(declaration, ".cjs"));
    outputs.push(esmPath, cjsPath);
  }

  const handwrittenGlob = new Bun.Glob("**/*.d.ts");
  for await (const relativePath of handwrittenGlob.scan(srcPath)) {
    const sourcePath = path.join(srcPath, relativePath);
    const outPath = path.join(outdir, relativePath);
    await copyFile(sourcePath, outPath);
    outputs.push(outPath);
  }
  return outputs;
};

const writeManifest = async (outdir: string) => {
  const rootSource = manifest.exports["."] ?? "";
  const exportsMap = Object.fromEntries(
    entries.map(([subpath, source]) => [
      subpath,
      {
        import: {
          types: toDist(source, ".d.ts"),
          default: toDist(source, ".js"),
        },
        require: {
          types: toDist(source, ".d.cts"),
          default: toDist(source, ".cjs"),
        },
      },
    ]),
  );
  const subpathTypes = Object.fromEntries(
    entries
      .filter(([subpath]) => subpath !== ".")
      .map(([subpath, source]) => [
        subpath.slice(2),
        [toDist(source, ".d.ts")],
      ]),
  );

  const distManifest = {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    type: "module",
    sideEffects: false,
    main: toDist(rootSource, ".cjs"),
    module: toDist(rootSource, ".js"),
    types: toDist(rootSource, ".d.ts"),
    typesVersions: { "*": subpathTypes },
    exports: exportsMap,
  };
  const outPath = path.join(outdir, "package.json");
  const content = `${JSON.stringify(distManifest, null, 2)}\n`;
  await Bun.write(outPath, content);
  return outPath;
};

export const buildSdk = async (outdir: string) => {
  await rm(outdir, { recursive: true, force: true });

  const esmOutputs = await buildModules(outdir, "esm", ".js");
  const cjsOutputs = await buildModules(outdir, "cjs", ".cjs");
  const declarationOutputs = await buildDeclarations(outdir);
  const manifestOutput = await writeManifest(outdir);

  const licenseOutput = path.join(outdir, "LICENSE");
  await copyFile(licensePath, licenseOutput);

  return [
    ...esmOutputs,
    ...cjsOutputs,
    ...declarationOutputs,
    manifestOutput,
    licenseOutput,
  ];
};

if (import.meta.main) {
  const outdir = path.join(sdkPath, "dist");
  const outputs = await buildSdk(outdir);
  console.log(outputs.join("\n"));
}
