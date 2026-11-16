import { buildSnapshot, hashSnapshot, type Snapshot } from "./builder";
import { SnapshotNotFoundError } from "./errors";
import { listSnapshots } from "./viewer";

export const resolveSnapshot = async (
  sourceDir: string,
  bubbleName: string,
  snapshotDir: string,
  snapshotHash?: string,
): Promise<Snapshot> => {
  if (snapshotHash === undefined) {
    return buildSnapshot(sourceDir, bubbleName, snapshotDir);
  }

  const snapshots = await listSnapshots(bubbleName, snapshotDir);
  const snapshot = snapshots.find(
    (candidate) => candidate.snapshotHash === snapshotHash,
  );
  if (!snapshot) {
    throw new SnapshotNotFoundError(bubbleName, snapshotHash);
  }

  const content = await Bun.file(snapshot.snapshotPath).text();
  const actualHash = hashSnapshot(content);
  if (actualHash !== snapshotHash) {
    throw new Error(
      `Snapshot hash mismatch: expected ${snapshotHash}, got ${actualHash}`,
    );
  }
  return snapshot;
};
