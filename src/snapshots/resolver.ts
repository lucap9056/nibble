import { buildSnapshot, hashSnapshot, type Snapshot } from "./builder";
import { listSnapshots } from "./viewer";

export const resolveSnapshot = async (
  sourceDir: string,
  sourcePath: string,
  snapshotDir: string,
  snapshotHash?: string,
): Promise<Snapshot> => {
  if (snapshotHash === undefined) {
    return buildSnapshot(sourceDir, sourcePath, snapshotDir);
  }

  const snapshots = await listSnapshots(sourceDir, sourcePath, snapshotDir);
  const snapshot = snapshots.find(
    (candidate) => candidate.snapshotHash === snapshotHash,
  );
  if (!snapshot) {
    throw new Error(`Snapshot not found: ${sourcePath}@${snapshotHash}`);
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
