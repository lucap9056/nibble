export class BubbleEntryNotFoundError extends Error {
  constructor(bubbleName: string) {
    super(`Bubble entry not found: ${bubbleName}`);
    this.name = "BubbleEntryNotFoundError";
  }
}

export class SnapshotNotFoundError extends Error {
  constructor(bubbleName: string, snapshotHash: string) {
    super(`Snapshot not found: ${bubbleName}@${snapshotHash}`);
    this.name = "SnapshotNotFoundError";
  }
}
