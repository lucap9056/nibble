import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import type { BunPlugin } from "bun";
import { findBubbleEntry } from "@/utils/path";
import { encodeDependencies } from "./dependencies";
import { BubbleEntryNotFoundError } from "./errors";

const NIBBLE_PACKAGE = /^@lucap9056\/nibble(\/|$)/;
const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;
const DEBUG_ID_COMMENT = /^\/\/# debugId=.*$/m;

export const SNAPSHOT_FILE_NAME = /^(\d+)-([0-9a-f]{64})\.js$/;

const SOURCEMAP_COMMENT = /^\/\/# sourceMappingURL=.*\n?$/m;

export const hashSnapshot = (content: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(content.replace(SOURCEMAP_COMMENT, ""))
    .digest("hex");

export interface Snapshot {
  bubbleName: string;
  snapshotPath: string;
  snapshotHash: string;
  createdAt: Date;
}

const findPackageId = (resolvedPath: string): string => {
  let dir = path.dirname(resolvedPath);
  while (true) {
    const manifestPath = path.join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const { name, version } = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (name && version) {
        return `${name}@${version}`;
      }
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      throw new Error(`Cannot find package.json for ${resolvedPath}`);
    }
    dir = parentDir;
  }
};

const createDependencyPlugin = (packageIds: Set<string>): BunPlugin => ({
  name: "nibble-snapshot-dependencies",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path: specifier, resolveDir }) => {
      if (path.isAbsolute(specifier) || isBuiltin(specifier)) {
        return;
      }
      if (NIBBLE_PACKAGE.test(specifier)) {
        return { path: specifier, external: true };
      }
      const resolvedPath = Bun.resolveSync(specifier, resolveDir);
      if (!resolvedPath.includes(NODE_MODULES_SEGMENT)) {
        return;
      }
      packageIds.add(findPackageId(resolvedPath));
      return { path: resolvedPath, external: true };
    });
  },
});

const writeAtomic = async (filePath: string, content: string) => {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tempPath, content);
  await rename(tempPath, filePath);
};

export const buildSnapshot = async (
  sourceDir: string,
  bubbleName: string,
  snapshotRootDir: string,
): Promise<Snapshot> => {
  const entryPath = await findBubbleEntry(sourceDir, bubbleName);
  if (!entryPath) {
    throw new BubbleEntryNotFoundError(bubbleName);
  }
  const snapshotDir = path.join(snapshotRootDir, bubbleName);
  const entryDir = JSON.stringify(path.dirname(entryPath));
  const packageIds = new Set<string>();
  const result = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    format: "esm",
    minify: { whitespace: true },
    sourcemap: "external",
    define: {
      "import.meta.dir": entryDir,
      "import.meta.dirname": entryDir,
    },
    plugins: [createDependencyPlugin(packageIds)],
    throw: false,
  });

  if (!result.success) {
    throw new AggregateError(
      result.logs,
      `Failed to build snapshot: ${entryPath}`,
    );
  }

  const entryOutput = result.outputs.find(({ kind }) => kind === "entry-point");
  const sourcemapOutput = result.outputs.find(
    ({ kind }) => kind === "sourcemap",
  );
  if (!entryOutput || !sourcemapOutput) {
    throw new Error(`Snapshot build produced no output: ${entryPath}`);
  }

  const code = (await entryOutput.text())
    .replace(DEBUG_ID_COMMENT, "")
    .trimEnd();
  const { debugId: _, ...sourcemap } = await sourcemapOutput.json();
  sourcemap.sources = sourcemap.sources.map((source: string) =>
    path
      .relative(snapshotDir, path.resolve(source))
      .split(path.sep)
      .join(path.posix.sep),
  );

  const encodedSourcemap = Buffer.from(JSON.stringify(sourcemap)).toString(
    "base64",
  );
  const content = [
    code,
    encodeDependencies(packageIds),
    `//# sourceMappingURL=data:application/json;base64,${encodedSourcemap}`,
    "",
  ].join("\n");

  const snapshotHash = hashSnapshot(content);
  await mkdir(snapshotDir, { recursive: true });
  const existingGlob = new Bun.Glob(`*-${snapshotHash}.js`);
  for await (const fileName of existingGlob.scan(snapshotDir)) {
    const [, timestamp] = fileName.match(SNAPSHOT_FILE_NAME) ?? [];
    const existingPath = path.join(snapshotDir, fileName);
    if (timestamp && (await Bun.file(existingPath).text()) === content) {
      const createdAt = new Date(Number(timestamp));

      return {
        bubbleName,
        snapshotPath: existingPath,
        snapshotHash,
        createdAt,
      };
    }
  }

  const createdAt = new Date();
  const snapshotFileName = `${createdAt.getTime()}-${snapshotHash}.js`;
  const snapshotPath = path.join(snapshotDir, snapshotFileName);
  await writeAtomic(snapshotPath, content);
  return { bubbleName, snapshotPath, snapshotHash, createdAt };
};
