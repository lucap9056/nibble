export enum BubbleControlType {
  Startup,
  Close,
}

interface BaseMessage {
  id: string;
}

export type StartupMessage = BaseMessage & {
  type: BubbleControlType.Startup;
  bubbleSourcePath: string;
  bubbleSocketPath: string;
};

export function newStartupMessage(
  bubbleSourcePath: string,
  bubbleSocketPath: string,
): StartupMessage {
  return {
    id: Bun.randomUUIDv7(),
    type: BubbleControlType.Startup,
    bubbleSourcePath,
    bubbleSocketPath,
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
