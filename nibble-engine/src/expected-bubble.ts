import { isBubbleName } from "@/utils/path";

export interface ExpectedBubble {
  name: string;
  snapshotHash?: string;
  routing: boolean;
}

export const isExpectedBubble = (value: unknown): value is ExpectedBubble => {
  if (typeof value !== "object" || value === null) return false;

  const { name, snapshotHash, routing } = value as Record<string, unknown>;
  if (typeof name !== "string" || !isBubbleName(name)) return false;
  if (
    snapshotHash !== undefined &&
    (typeof snapshotHash !== "string" || snapshotHash.length === 0)
  ) {
    return false;
  }

  return typeof routing === "boolean";
};
