import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const rootPath = path.resolve(import.meta.dir, "..");
const goModulePath = path.join(rootPath, "router");
const goOutPath = path.join(goModulePath, "internal/routerpb");
const tsOutPath = path.join(rootPath, "src/router/pb");
const tsGeneratedPath = path.join(tsOutPath, "router");

const TS_PROTO_OPTIONS = [
  "esModuleInterop=true",
  "oneof=unions-value",
  "outputJsonMethods=false",
  "outputPartialMethods=false",
  "outputServices=false",
  "importSuffix=.ts",
];

const resolvePlugin = (name: string) => {
  const pluginPath = Bun.which(name);
  if (pluginPath === null) {
    throw new Error(`${name} not found in PATH`);
  }
  return `--plugin=${name}=${pluginPath}`;
};

const protoFiles = [
  ...new Bun.Glob("router/**/*.proto").scanSync(rootPath),
].map((file) => file.split(path.sep).join(path.posix.sep));

await Promise.all(
  [goOutPath, tsGeneratedPath].map(async (outPath) => {
    await rm(outPath, { recursive: true, force: true });
    await mkdir(outPath, { recursive: true });
  }),
);

const protoc = Bun.spawnSync(
  [
    "protoc",
    resolvePlugin("protoc-gen-go"),
    resolvePlugin("protoc-gen-ts_proto"),
    `--proto_path=${rootPath}`,
    `--go_out=${goModulePath}`,
    "--go_opt=module=router",
    `--ts_proto_out=${tsOutPath}`,
    `--ts_proto_opt=${TS_PROTO_OPTIONS.join(",")}`,
    ...protoFiles,
  ],
  { cwd: rootPath, stdout: "inherit", stderr: "inherit" },
);

if (!protoc.success) {
  process.exit(protoc.exitCode ?? 1);
}

for (const file of protoFiles) {
  console.log(file);
}
