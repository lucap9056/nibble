import path from "node:path";
import config from "@/config";
import { SOURCE_EXTENSION, toRelativePosixPath } from "@/utils/path";
import { BubbleState } from "./bubble-state";
import { BubbleWorker } from "./bubble-worker";
import { BubbleSocketLink } from "./socket-link";

export interface BubbleHandlers {
  onStateChange: (
    worker: { id: string; socketPath: string },
    state: BubbleState,
  ) => void | Promise<void>;
}

export class Bubble {
  private readonly eventHandlers: BubbleHandlers;
  private readonly sourcePath: string;
  private readonly socketDir: string;
  private readonly link: BubbleSocketLink;
  private readonly workers = new Set<BubbleWorker>();
  private currentWorker?: BubbleWorker;

  constructor(sourcePath: string, eventHandlers: BubbleHandlers) {
    this.eventHandlers = eventHandlers;

    const relativeSourcePath = toRelativePosixPath(
      config.bubbleSourceDir,
      sourcePath,
    );
    const socketName = relativeSourcePath.replace(SOURCE_EXTENSION, "");
    const socketPath = `${path.join(config.bubbleSocketDir, socketName)}.sock`;
    this.sourcePath = path.join(config.bubbleSourceDir, relativeSourcePath);
    this.socketDir = path.dirname(socketPath);
    this.link = new BubbleSocketLink(socketPath);
  }

  private onWorkerStateChange(worker: BubbleWorker, state: BubbleState) {
    const current = this.currentWorker;

    const isActive = (candidate: BubbleWorker) =>
      candidate.state === BubbleState.Starting ||
      candidate.state === BubbleState.Running;

    const isOutdated = (candidate: BubbleWorker, than: BubbleWorker) =>
      candidate.createdAt < than.createdAt;

    const pickLatest = (filter: (candidate: BubbleWorker) => boolean) => {
      let latest: BubbleWorker | undefined;
      for (const candidate of this.workers) {
        if (candidate === worker || !filter(candidate)) {
          continue;
        }
        if (!latest || !isOutdated(candidate, latest)) {
          latest = candidate;
        }
      }
      return latest;
    };

    switch (state) {
      case BubbleState.Starting: {
        if (current && isActive(current)) {
          if (isOutdated(worker, current)) {
            worker.stop(true);
          } else {
            if (current.state === BubbleState.Starting) {
              this.currentWorker = worker;
            }
          }
          return;
        }

        this.currentWorker = worker;
        this.emit(worker, BubbleState.Starting);
        return;
      }
      case BubbleState.Running: {
        if (worker === current) {
          this.emit(worker, BubbleState.Running);
          return;
        }

        if (current && isActive(current) && isOutdated(worker, current)) {
          worker.stop(false);
          return;
        }

        this.currentWorker = worker;
        if (current && isActive(current)) {
          this.syncLink().finally(() => {
            current.stop(false);
          });
        }

        this.emit(worker, BubbleState.Running);
        return;
      }
      case BubbleState.Stopping: {
        if (!current) {
          this.currentWorker = worker;
          this.emit(worker, BubbleState.Stopping);
          return;
        }

        if (worker !== current) {
          return;
        }

        const successor = pickLatest(isActive);
        if (successor) {
          this.currentWorker = successor;
          this.emit(successor, successor.state);
        } else {
          this.emit(worker, BubbleState.Stopping);
        }

        return;
      }
      case BubbleState.Exited: {
        this.workers.delete(worker);
        if (current && worker !== current) return;

        const successor = pickLatest(isActive) ?? pickLatest(() => true);
        this.currentWorker = successor;
        if (!successor) {
          this.emit(worker, BubbleState.Idle);
        } else {
          if (isActive(successor) || !current) {
            this.emit(successor, successor.state);
          }
        }
        return;
      }
    }
  }

  private emit(worker: BubbleWorker, state: BubbleState) {
    const { id, socketPath } =
      state === BubbleState.Idle ? { id: "", socketPath: "" } : worker;
    try {
      this.eventHandlers.onStateChange({ id, socketPath }, state);
    } catch {}
  }

  private syncLink(): Promise<void> {
    const current = this.currentWorker;
    const target =
      current?.state === BubbleState.Running ? current.socketPath : undefined;

    return this.link.point(target).catch((err) => {
      console.error(err);
    });
  }

  private spawnWorker(createdAt: number): BubbleWorker {
    const worker = new BubbleWorker(createdAt, {
      onStateChange: (state) => {
        this.onWorkerStateChange(worker, state);
        this.syncLink();
      },
    });

    return worker;
  }

  public start(createdAt: number): Promise<void> {
    const oldWorker = this.currentWorker;
    const worker = this.spawnWorker(createdAt);
    const socketPath = path.join(this.socketDir, worker.id);
    this.workers.add(worker);

    const started = worker.start(this.sourcePath, socketPath);

    const isReplaced = oldWorker !== this.currentWorker;
    if (isReplaced && oldWorker?.state === BubbleState.Starting) {
      oldWorker.stop(true);
    }

    return started;
  }

  public stop(force: boolean): Promise<void> {
    if (this.workers.size === 0) {
      return this.link.release();
    }
    const stopped = Promise.resolve().then(async () => {
      const stops = this.workers
        .values()
        .toArray()
        .map((worker) => worker.stop(force));

      const errs = await Promise.allSettled([
        ...stops,
        this.link.release(),
      ]).then((results) => {
        return results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason as Error);
      });

      if (errs.length > 0) {
        throw new AggregateError(errs);
      }
    });

    this.currentWorker = undefined;
    return stopped;
  }
}
