import path from "node:path";

const isOutsideDir = (relativePath: string): boolean =>
  relativePath === "" ||
  relativePath === ".." ||
  relativePath.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativePath);

export const toRelativePosixPath = (
  baseDir: string,
  targetPath: string,
): string => {
  const relativePath = path.relative(
    baseDir,
    path.resolve(baseDir, targetPath),
  );

  if (isOutsideDir(relativePath)) {
    throw new Error(`Path must be inside ${baseDir}: ${targetPath}`);
  }

  return relativePath.split(path.sep).join(path.posix.sep);
};

// Same order Bun uses for an extensionless import, so `import "./foo.bubble"` and nibble pick the same entry.
export const BUBBLE_ENTRY_EXTENSIONS = [
  "tsx",
  "jsx",
  "mts",
  "ts",
  "mjs",
  "js",
  "cts",
  "cjs",
];

const BUBBLE_ENTRY_SUFFIX = new RegExp(
  `\\.bubble\\.(?:${BUBBLE_ENTRY_EXTENSIONS.join("|")})$`,
);

// Must stay in sync with segmentPattern in router/internal/routes; one invalid route rejects the whole table.
const ROUTE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export const toBubbleName = (baseDir: string, sourcePath: string): string => {
  const relativeSourcePath = toRelativePosixPath(baseDir, sourcePath);
  if (!BUBBLE_ENTRY_SUFFIX.test(relativeSourcePath)) {
    throw new Error(
      `Bubble entry must match ${BUBBLE_ENTRY_SUFFIX}: ${sourcePath}`,
    );
  }

  const bubbleName = relativeSourcePath.replace(BUBBLE_ENTRY_SUFFIX, "");
  const segments = bubbleName.split(path.posix.sep);
  if (!segments.every((segment) => ROUTE_SEGMENT.test(segment))) {
    throw new Error(`Invalid bubble name "${bubbleName}": ${sourcePath}`);
  }
  return bubbleName;
};

export const resolveBubbleEntry = async (
  baseDir: string,
  bubbleName: string,
): Promise<string> => {
  for (const extension of BUBBLE_ENTRY_EXTENSIONS) {
    const entryPath = path.join(baseDir, `${bubbleName}.bubble.${extension}`);
    if (await Bun.file(entryPath).exists()) {
      return entryPath;
    }
  }
  throw new Error(`Bubble entry not found: ${bubbleName}`);
};

const INDEX_SEGMENT = /(^|\/)index$/;

export const toRoutePath = (bubbleName: string): string =>
  `/${bubbleName.replace(INDEX_SEGMENT, "$1")}`;
