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
