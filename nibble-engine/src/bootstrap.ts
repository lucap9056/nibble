import { type ExpectedBubble, isExpectedBubble } from "@/expected-bubble";
import {
  type BootstrapRejection,
  type BootstrapRejectReason,
  type DaemonEndpoint,
  isDaemonEndpoint,
  toReportError,
} from "@/report";
import { BubbleEntryNotFoundError } from "@/snapshots";
import type { Logger } from "@/utils/logger";
import { findBubbleEntry } from "@/utils/path";

export interface Bootstrap {
  daemon?: DaemonEndpoint;
  bubbles: ExpectedBubble[];
  rejected: BootstrapRejection[];
  stdinClosed: Promise<void>;
}

const drain = async (lines: AsyncIterator<string>) => {
  while (!(await lines.next()).done) {}
};

const entryName = (entry: unknown) => {
  const { name } = (entry ?? {}) as Record<string, unknown>;
  return typeof name === "string" ? name : undefined;
};

export const readBootstrap = async (
  logger: Logger,
  sourceDir: string,
): Promise<Bootstrap> => {
  // biome-ignore lint/suspicious/noConsole: Bun exposes line-buffered stdin only through the console async iterator
  const lines = console[Symbol.asyncIterator]();
  const { value: firstLine, done } = await lines.next();
  if (done) {
    throw new Error("stdin closed before bootstrap was received");
  }

  const { daemon, bubbles: entries } = JSON.parse(firstLine);
  if (daemon !== undefined && !isDaemonEndpoint(daemon)) {
    throw new Error(
      "bootstrap.daemon.id and bootstrap.daemon.reportSocket must be non-empty strings",
    );
  }
  if (!Array.isArray(entries)) {
    throw new Error("bootstrap.bubbles must be an array");
  }

  const bubbles: ExpectedBubble[] = [];
  const rejected: BootstrapRejection[] = [];
  const reject = (
    index: number,
    name: string | undefined,
    reason: BootstrapRejectReason,
    err: Error,
  ) => {
    logger.warn("bootstrap bubble rejected", { index, bubble: name, reason });
    const error = toReportError(err);
    rejected.push({ index, name, reason, error });
  };

  const seenNames = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!isExpectedBubble(entry)) {
      const name = entryName(entry);
      const err = new Error("Invalid bubble entry");
      reject(index, name, "invalid", err);
      continue;
    }
    const { name, snapshotHash, routing } = entry;
    if (seenNames.has(name)) {
      const err = new Error(`Duplicate bubble name: ${name}`);
      reject(index, name, "duplicate", err);
      continue;
    }
    seenNames.add(name);
    const entryPath = await findBubbleEntry(sourceDir, name);
    if (entryPath === undefined) {
      const err = new BubbleEntryNotFoundError(name);
      reject(index, name, "missing-source", err);
      continue;
    }
    bubbles.push({ name, snapshotHash, routing });
  }

  return { daemon, bubbles, rejected, stdinClosed: drain(lines) };
};
