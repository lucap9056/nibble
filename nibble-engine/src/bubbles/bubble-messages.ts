import type { LogFields } from "@/utils/logger";

export enum BubbleControlType {
  Startup,
  Close,
}

interface BaseMessage {
  id: string;
}

export type StartupMessage = BaseMessage & {
  type: BubbleControlType.Startup;
  bubbleSnapshotPath: string;
  bubbleSocketPath: string;
  logFields: LogFields;
};

export function newStartupMessage(
  bubbleSnapshotPath: string,
  bubbleSocketPath: string,
  logFields: LogFields,
): StartupMessage {
  return {
    id: Bun.randomUUIDv7(),
    type: BubbleControlType.Startup,
    bubbleSnapshotPath,
    bubbleSocketPath,
    logFields,
  };
}

export type CloseMessage = BaseMessage & {
  type: BubbleControlType.Close;
  force: boolean;
};

export function newCloseMessage(force: boolean): CloseMessage {
  return {
    id: Bun.randomUUIDv7(),
    type: BubbleControlType.Close,
    force,
  };
}

export type BubbleControlMessage = StartupMessage | CloseMessage;

export enum BubbleResultType {
  Success,
  Error,
}

export interface SuccessMessage {
  type: BubbleResultType.Success;
  id: string;
}

export function newSuccessMessage(id: string): SuccessMessage {
  return { type: BubbleResultType.Success, id };
}

export interface ErrorMessage {
  type: BubbleResultType.Error;
  id: string;
  error: { name: string; message: string; stack?: string };
}

export function newErrorMessage(id: string, err: Error): ErrorMessage {
  const { name, message, stack } = err;
  return { type: BubbleResultType.Error, id, error: { name, message, stack } };
}

export type ResultMessage = SuccessMessage | ErrorMessage;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function isResultMessage(value: unknown): value is ResultMessage {
  if (!isRecord(value) || typeof value.id !== "string") {
    return false;
  }
  switch (value.type) {
    case BubbleResultType.Success:
      return true;
    case BubbleResultType.Error: {
      const { error } = value;
      return (
        isRecord(error) &&
        typeof error.name === "string" &&
        typeof error.message === "string" &&
        (error.stack === undefined || typeof error.stack === "string")
      );
    }
    default:
      return false;
  }
}
