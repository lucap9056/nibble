import type { BubbleManager } from "@/manager";
import {
  BubbleEntryNotFoundError,
  SnapshotNotFoundError,
} from "@/snapshots/errors";
import type { Logger } from "@/utils/logger";
import { isBubbleName } from "@/utils/path";

export interface ControlContext {
  manager: Pick<BubbleManager, "stats" | "sync" | "remove" | "restart">;
  logger: Logger;
  sourceDir: string;
  snapshotDir: string;
}

export class ControlError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const toErrorStatus = (err: unknown): number => {
  switch (true) {
    case err instanceof ControlError:
      return err.status;
    case err instanceof BubbleEntryNotFoundError:
    case err instanceof SnapshotNotFoundError:
      return 404;
    case err instanceof AggregateError:
      return 422;
    default:
      return 500;
  }
};

const toErrorMessage = (err: unknown): string => {
  if (err instanceof AggregateError) {
    const causes = err.errors.map(String);
    return [err.message, ...causes].join("\n");
  }

  return err instanceof Error ? err.message : String(err);
};

export const handle =
  (handler: (req: Request) => Promise<Response>) =>
  async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err) {
      const error = toErrorMessage(err);
      const status = toErrorStatus(err);
      return Response.json({ error }, { status });
    }
  };

export const parseBubbleName = (req: Request, prefix: string): string => {
  const bubbleName = new URL(req.url).pathname.slice(prefix.length);
  if (!isBubbleName(bubbleName)) {
    throw new ControlError(400, `Invalid bubble name: ${bubbleName}`);
  }

  return bubbleName;
};

export const createSerialQueue = () => {
  const tails = new Map<string, Promise<unknown>>();

  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    tails.set(key, next);

    const release = () => {
      if (tails.get(key) === next) {
        tails.delete(key);
      }
    };
    next.then(release, release);

    return next;
  };
};

export type SerialQueue = ReturnType<typeof createSerialQueue>;
