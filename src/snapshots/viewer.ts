import { existsSync } from "node:fs";
import path from "node:path";
import { toRelativePosixPath } from "@/utils/path";
import { SNAPSHOT_FILE_NAME, type Snapshot } from "./builder";

export const listSnapshots = async (
  sourceDir: string,
  sourcePath: string,
  snapshotRootDir: string,
): Promise<Snapshot[]> => {
  const relativeSourcePath = toRelativePosixPath(sourceDir, sourcePath);
  const snapshotDir = path.resolve(snapshotRootDir, relativeSourcePath);
  if (!existsSync(snapshotDir)) {
    return [];
  }

  const entryPath = path.resolve(sourceDir, relativeSourcePath);
  const snapshotGlob = new Bun.Glob("*.js");
  const entries: Snapshot[] = [];
  for await (const fileName of snapshotGlob.scan(snapshotDir)) {
    const [, timestamp, snapshotHash] =
      fileName.match(SNAPSHOT_FILE_NAME) ?? [];
    if (!timestamp || !snapshotHash) {
      continue;
    }
    const snapshotPath = path.join(snapshotDir, fileName);
    const createdAt = new Date(Number(timestamp));

    entries.push({
      sourcePath: entryPath,
      snapshotPath,
      snapshotHash,
      createdAt,
    });
  }

  return entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
};
