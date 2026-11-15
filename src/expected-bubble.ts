import { BubbleOption } from "@/manager";

export interface ExpectedBubble {
  path: string; // sourcePath
  hash?: string; // snapshotHash
  options: number;
}

const VALID_OPTIONS_MASK = Object.values(BubbleOption)
  .filter((value) => typeof value === "number")
  .reduce((mask, flag) => mask | flag, 0);

export const isExpectedBubble = (value: unknown): value is ExpectedBubble => {
  if (typeof value !== "object" || value === null) return false;

  const { path, hash, options } = value as Record<string, unknown>;
  if (typeof path !== "string" || path.length === 0) return false;
  if (hash !== undefined && typeof hash !== "string") return false;

  return (
    typeof options === "number" &&
    Number.isInteger(options) &&
    (options & ~VALID_OPTIONS_MASK) === 0
  );
};
