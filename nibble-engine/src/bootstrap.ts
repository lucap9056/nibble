import { type ExpectedBubble, isExpectedBubble } from "@/expected-bubble";
import type { Logger } from "@/utils/logger";

export interface Bootstrap {
  bubbles: ExpectedBubble[];
  stdinClosed: Promise<void>;
}

const drain = async (lines: AsyncIterator<string>) => {
  while (!(await lines.next()).done) {}
};

export const readBootstrap = async (logger: Logger): Promise<Bootstrap> => {
  // biome-ignore lint/suspicious/noConsole: Bun exposes line-buffered stdin only through the console async iterator
  const lines = console[Symbol.asyncIterator]();
  const { value: firstLine, done } = await lines.next();
  if (done) {
    throw new Error("stdin closed before bootstrap was received");
  }

  const { bubbles } = JSON.parse(firstLine);
  if (!Array.isArray(bubbles)) {
    throw new Error("bootstrap.bubbles must be an array");
  }

  const validBubbles = bubbles.filter((bubble, index) => {
    const valid = isExpectedBubble(bubble);
    if (!valid) {
      logger.warn("invalid bubble entry skipped", { index, entry: bubble });
    }
    return valid;
  });

  return { bubbles: validBubbles, stdinClosed: drain(lines) };
};
