import { existsSync } from "node:fs";
import path from "node:path";
import { SNAPSHOT_FILE_NAME, type Snapshot } from "./builder";

export const listSnapshots = async (
  bubbleName: string,
  snapshotRootDir: string,
): Promise<Snapshot[]> => {
  const snapshotDir = path.join(snapshotRootDir, bubbleName);
  if (!existsSync(snapshotDir)) {
    return [];
  }

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

    entries.push({ bubbleName, snapshotPath, snapshotHash, createdAt });
  }

  return entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
};
