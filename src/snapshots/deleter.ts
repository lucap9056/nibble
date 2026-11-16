import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { SnapshotNotFoundError } from "./errors";
import { listSnapshots } from "./viewer";

export const deleteSnapshot = async (
  bubbleName: string,
  snapshotRootDir: string,
  snapshotHash: string,
): Promise<void> => {
  const snapshots = await listSnapshots(bubbleName, snapshotRootDir);
  const snapshot = snapshots.find(
    (candidate) => candidate.snapshotHash === snapshotHash,
  );
  if (!snapshot) {
    throw new SnapshotNotFoundError(bubbleName, snapshotHash);
  }

  await rm(snapshot.snapshotPath);

  const bubbleSnapshotDir = path.dirname(snapshot.snapshotPath);
  await rmdir(bubbleSnapshotDir).catch(() => {});
};
