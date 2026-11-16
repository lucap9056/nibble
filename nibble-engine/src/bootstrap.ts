import { type ExpectedBubble, isExpectedBubble } from "@/expected-bubble";
import {
  type BootstrapFailure,
  type DaemonEndpoint,
  isDaemonEndpoint,
  toBootstrapFailure,
} from "@/report";
import type { Logger } from "@/utils/logger";

export interface BootstrapBubble extends ExpectedBubble {
  index: number;
}

export interface Bootstrap {
  daemon?: DaemonEndpoint;
  bubbles: BootstrapBubble[];
  failures: BootstrapFailure[];
  stdinClosed: Promise<void>;
}

const drain = async (lines: AsyncIterator<string>) => {
  while (!(await lines.next()).done) {}
};

const entryName = (entry: unknown) => {
  const { name } = (entry ?? {}) as Record<string, unknown>;
  return typeof name === "string" ? name : undefined;
};

export const readBootstrap = async (logger: Logger): Promise<Bootstrap> => {
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

  const bubbles: BootstrapBubble[] = [];
  const failures: BootstrapFailure[] = [];
  const seenNames = new Set<string>();
  entries.forEach((entry: unknown, index) => {
    if (!isExpectedBubble(entry)) {
      const name = entryName(entry);
      const err = new Error("Invalid bubble entry");
      logger.warn("invalid bubble entry skipped", { index, entry });
      failures.push(toBootstrapFailure(index, name, "invalid", err));
      return;
    }
    const { name, snapshotHash, routing } = entry;
    if (seenNames.has(name)) {
      const err = new Error(`Duplicate bubble name: ${name}`);
      logger.warn("duplicate bubble entry skipped", { index, bubble: name });
      failures.push(toBootstrapFailure(index, name, "duplicate", err));
      return;
    }
    seenNames.add(name);
    bubbles.push({ index, name, snapshotHash, routing });
  });

  return { daemon, bubbles, failures, stdinClosed: drain(lines) };
};
