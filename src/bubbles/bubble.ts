import { rm } from "node:fs/promises";
import path from "node:path";
import config from "@/config";
import { BubbleAbortController } from "./abort-controller";
import { ExitEvent, StateChangeEvent } from "./bubble-events";
import {
  type BubbleControlMessage,
  BubbleControlType,
  BubbleResultType,
  newCloseMessage,
  newStartupMessage,
  type ResultMessage,
} from "./bubble-messages";
import { BubbleState } from "./bubble-state";

type Resolvers = Pick<PromiseWithResolvers<void>, "resolve" | "reject">;

interface BubbleWorkerHandlers {
  onStateChange: (state: BubbleState) => void;
  onExit: (error?: Error) => void;
}

class BubbleWorker extends Worker {
  private static unlinkSocket(socketPath: string) {
    if (socketPath === "") {
      return Promise.resolve();
    }

    return Promise.all([
      rm(socketPath, { force: true }),
      rm(`${socketPath}.temp`, { force: true }),
    ])
      .then(() => {})
      .catch((err) => {
        console.error(err);
      });
  }

  private readonly messages: Map<string, Resolvers>;
  private readonly ctr: BubbleAbortController;
  private readonly onStateChange: (state: BubbleState) => void;
  private currentState: BubbleState = BubbleState.Idle;
  private socketPath = "";
  public readonly exited: Promise<void>;

  constructor({ onStateChange, onExit }: BubbleWorkerHandlers) {
    super(new URL("./bubble.worker.ts", import.meta.url));
    const messages = new Map<string, Resolvers>();
    const ctr = new BubbleAbortController();
    const exit = Promise.withResolvers<void>();
    exit.promise.catch(() => {});

    ctr.signal.addEventListener("abort", () => {
      this.terminate();

      BubbleWorker.unlinkSocket(this.socketPath).finally(() => {
        const error = BubbleAbortController.getAbortReason(ctr.signal);

        for (const msg of messages.values()) {
          const pendingError =
            error ?? new Error("Bubble worker exited before responding");
          msg.reject(pendingError);
        }
        messages.clear();

        this.setState(BubbleState.Idle);
        if (error) {
          exit.reject(error);
        } else {
          exit.resolve();
        }
        onExit(error);
      });
    });

    this.addEventListener("message", (e: MessageEvent<ResultMessage>) => {
      const msg = messages.get(e.data.id);
      if (msg === undefined) return;

      const { resolve, reject } = msg;
      messages.delete(e.data.id);

      switch (e.data.type) {
        case BubbleResultType.Success:
          return resolve();
        case BubbleResultType.Error: {
          const { name, message, stack } = e.data.error;
          const err = new Error(message);
          err.name = name;
          err.stack = stack;
          return reject(err);
        }
      }
    });

    this.addEventListener("error", (e) => {
      ctr.abort(
        e.error ?? new Error(`Bubble worker error: ${e.message || "unknown"}`),
      );
    });

    this.addEventListener("messageerror", () => {
      const msgs = messages.entries();
      for (const [id, message] of msgs) {
        message.reject(
          new Error("Failed to deserialize message from bubble worker"),
        );
        messages.delete(id);
      }
      if (this.currentState !== BubbleState.Running) {
        ctr.abort(
          new Error(
            "Failed to deserialize message from bubble worker before it was running",
          ),
        );
      }
    });

    this.onStateChange = onStateChange;
    this.messages = messages;
    this.ctr = ctr;
    this.exited = exit.promise;
  }

  public send(msg: BubbleControlMessage): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.messages.set(msg.id, { resolve, reject });
    this.postMessage(msg);

    switch (msg.type) {
      case BubbleControlType.Startup: {
        this.socketPath = msg.bubbleSocketPath;
        break;
      }
      case BubbleControlType.Close: {
        const timeout = setTimeout(() => {
          reject(
            new Error("Bubble worker did not respond to close in 10000ms"),
          );
          this.messages.delete(msg.id);
        }, 10000);

        promise
          .finally(() => {
            clearTimeout(timeout);
          })
          .catch(() => {});
        break;
      }
    }

    return promise;
  }

  public get state(): BubbleState {
    return this.currentState;
  }

  public setState(state: BubbleState) {
    if (this.currentState === state) return;
    this.currentState = state;
    this.onStateChange(state);
  }

  public get signal() {
    return this.ctr.signal;
  }

  public abort(error?: Error) {
    this.ctr.abort(error);
  }
}

class BubbleStatus {
  constructor(
    public readonly promise: Promise<void>,
    public readonly worker?: BubbleWorker,
  ) {}

  public get state() {
    return this.worker?.state ?? BubbleState.Idle;
  }
}

const IDLE_STATUS: BubbleStatus = new BubbleStatus(Promise.resolve());

export class Bubble extends EventTarget {
  private static SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

  private static isOutsideDir(relativePath: string): boolean {
    return (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    );
  }

  private static resolveSocketPath(absoluteSourcePath: string): string {
    const relativePath = path.relative(
      config.bubbleSourceDir,
      absoluteSourcePath,
    );

    if (Bubble.isOutsideDir(relativePath)) {
      throw new Error(
        `Bubble source must be inside ${config.bubbleSourceDir}: ${absoluteSourcePath}`,
      );
    }

    const socketName = relativePath.replace(Bubble.SOURCE_EXTENSION, "");
    return `${path.join(config.bubbleSocketDir, socketName)}.sock`;
  }

  private readonly sourcePath: string;
  private readonly socketPath: string;
  private status: BubbleStatus = IDLE_STATUS;

  constructor(sourcePath: string) {
    super();
    const absoluteSourcePath = path.resolve(sourcePath);
    const absoluteSocketPath = Bubble.resolveSocketPath(absoluteSourcePath);
    this.sourcePath = absoluteSourcePath;
    this.socketPath = absoluteSocketPath;
  }

  private waitForExit(worker: BubbleWorker, error?: Error): Promise<void> {
    worker.abort(error);
    return worker.exited;
  }

  private updateStatus(promise: Promise<void>, worker?: BubbleWorker) {
    this.status = new BubbleStatus(promise, worker);
  }

  private spawnWorker(): BubbleWorker {
    const worker = new BubbleWorker({
      onStateChange: (state) => {
        if (this.status.worker === worker) {
          this.dispatchEvent(new StateChangeEvent(state));
        }
      },
      onExit: (error) => {
        if (this.status.worker === worker) {
          this.status = IDLE_STATUS;
        }
        this.dispatchEvent(new ExitEvent(error));
      },
    });

    worker.addEventListener("close", () => {
      if (!worker.signal.aborted) {
        const promise = this.waitForExit(
          worker,
          new Error(`Bubble worker exited unexpectedly: ${this.sourcePath}`),
        );
        this.updateStatus(promise, worker);
        worker.setState(BubbleState.Stopping);
      }
    });

    return worker;
  }

  public get state() {
    return this.status.state;
  }

  public start(): Promise<void> {
    const currentStatus = this.status;
    switch (currentStatus.state) {
      case BubbleState.Idle:
        break;
      case BubbleState.Starting:
      case BubbleState.Running:
        return currentStatus.promise;
      case BubbleState.Stopping:
        return Promise.reject(
          new Error(
            `Cannot start bubble in ${BubbleState[currentStatus.state]} state: ${this.sourcePath}`,
          ),
        );
    }

    const worker = this.spawnWorker();

    const promise = worker
      .send(newStartupMessage(this.sourcePath, this.socketPath))
      .then(() => {
        if (worker.state === BubbleState.Starting) {
          worker.setState(BubbleState.Running);
        }
      })
      .catch((err: Error) => {
        worker.abort(err);
        throw err;
      });

    this.updateStatus(promise, worker);
    worker.setState(BubbleState.Starting);
    return promise;
  }

  public stop(force: boolean): Promise<void> {
    const { promise: currentPromise, worker } = this.status;
    if (worker === undefined) {
      return Promise.resolve();
    }

    switch (worker.state) {
      case BubbleState.Starting: {
        const promise = this.waitForExit(worker);
        this.updateStatus(promise, worker);
        worker.setState(BubbleState.Stopping);
        return promise;
      }
      case BubbleState.Running:
        break;
      case BubbleState.Idle:
      case BubbleState.Stopping:
        return currentPromise;
    }

    const promise = worker
      .send(newCloseMessage(force))
      .then(() => this.waitForExit(worker))
      .catch((err: Error) => this.waitForExit(worker, err));

    this.updateStatus(promise, worker);
    worker.setState(BubbleState.Stopping);
    return promise;
  }
}
