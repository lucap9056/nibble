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

const BUBBLE_ENTRY_ALTERNATION = BUBBLE_ENTRY_EXTENSIONS.join("|");
const BUBBLE_ENTRY_SUFFIX = new RegExp(
  `\\.bubble\\.(?:${BUBBLE_ENTRY_ALTERNATION})$`,
);

// Must stay in sync with segmentPattern in router/internal/routes; one invalid route rejects the whole table.
const ROUTE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export const isBubbleName = (name: string): boolean =>
  name
    .split(path.posix.sep)
    .every(
      (segment) =>
        segment !== "." && segment !== ".." && ROUTE_SEGMENT.test(segment),
    );

export const toBubbleName = (baseDir: string, sourcePath: string): string => {
  const relativeSourcePath = toRelativePosixPath(baseDir, sourcePath);
  if (!BUBBLE_ENTRY_SUFFIX.test(relativeSourcePath)) {
    throw new Error(
      `Bubble entry must match ${BUBBLE_ENTRY_SUFFIX}: ${sourcePath}`,
    );
  }

  const bubbleName = relativeSourcePath.replace(BUBBLE_ENTRY_SUFFIX, "");
  if (!isBubbleName(bubbleName)) {
    throw new Error(`Invalid bubble name "${bubbleName}": ${sourcePath}`);
  }
  return bubbleName;
};

export const findBubbleEntry = async (
  baseDir: string,
  bubbleName: string,
): Promise<string | undefined> => {
  for (const extension of BUBBLE_ENTRY_EXTENSIONS) {
    const entryPath = path.join(baseDir, `${bubbleName}.bubble.${extension}`);
    if (await Bun.file(entryPath).exists()) {
      return entryPath;
    }
  }
};

export interface BubbleEntry {
  bubbleName: string;
  entryPath: string;
}

const NODE_MODULES_SEGMENT = /(^|[\\/])node_modules[\\/]/;

export const listBubbleEntries = async (
  baseDir: string,
): Promise<BubbleEntry[]> => {
  const extensionGroup = BUBBLE_ENTRY_EXTENSIONS.join(",");
  const entryGlob = new Bun.Glob(`**/*.bubble.{${extensionGroup}}`);
  const ranked = new Map<string, BubbleEntry & { rank: number }>();

  for await (const relativePath of entryGlob.scan(baseDir)) {
    if (NODE_MODULES_SEGMENT.test(relativePath)) {
      continue;
    }

    let bubbleName: string;
    try {
      bubbleName = toBubbleName(baseDir, relativePath);
    } catch {
      continue;
    }

    const extension = path.extname(relativePath).slice(1);
    const rank = BUBBLE_ENTRY_EXTENSIONS.indexOf(extension);

    const current = ranked.get(bubbleName);
    if (!current || rank < current.rank) {
      const entryPath = path.join(baseDir, relativePath);
      ranked.set(bubbleName, { bubbleName, entryPath, rank });
    }
  }

  return ranked
    .values()
    .map(({ bubbleName, entryPath }) => ({ bubbleName, entryPath }))
    .toArray()
    .sort((a, b) => a.bubbleName.localeCompare(b.bubbleName));
};

const INDEX_SEGMENT = /(^|\/)index$/;

export const toRoutePath = (bubbleName: string): string =>
  `/${bubbleName.replace(INDEX_SEGMENT, "$1")}`;
