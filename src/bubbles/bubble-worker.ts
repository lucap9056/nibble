import { rm } from "node:fs/promises";
import type { Logger } from "@/utils/logger";
import { PendingRequests } from "@/utils/pending-requests";
import { BubbleAbortController } from "./abort-controller";
import {
  type BubbleControlMessage,
  BubbleControlType,
  BubbleResultType,
  isResultMessage,
  newCloseMessage,
  newStartupMessage,
} from "./bubble-messages";
import { BubbleState } from "./bubble-state";

const CLOSE_TIMEOUT_MS = 10000;

export interface BubbleWorkerHandlers {
  onStateChange: (state: BubbleState) => void;
}

export class BubbleWorker extends Worker {
  private static generateId(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString(
      "hex",
    );
  }

  private static unlinkSocket(socketPath: string, logger: Logger) {
    if (socketPath === "") {
      return Promise.resolve();
    }

    return rm(socketPath, { force: true })
      .then(() => {})
      .catch((err) => {
        logger.error("socket unlink failed", { socketPath, err });
      });
  }

  public readonly id = BubbleWorker.generateId();
  public readonly createdAt: number;
  private readonly eventHandlers: BubbleWorkerHandlers;
  private readonly logger: Logger;
  private readonly messages: PendingRequests<void>;
  private readonly ctr: BubbleAbortController;
  private currentState = BubbleState.Idle;
  private boundSocketPath = "";
  public readonly exited: Promise<void>;

  constructor(
    createdAt: number,
    eventHandlers: BubbleWorkerHandlers,
    logger: Logger,
  ) {
    super(new URL("./bubble.worker.ts", import.meta.url));
    const workerLogger = logger.with({ worker: this.id });
    const messages = new PendingRequests<void>();
    const ctr = new BubbleAbortController();
    const exit = Promise.withResolvers<void>();
    exit.promise.catch(() => {});

    ctr.signal.addEventListener("abort", () => {
      this.setState(BubbleState.Stopping);
      this.terminate();

      BubbleWorker.unlinkSocket(this.boundSocketPath, workerLogger).finally(
        () => {
          const error = BubbleAbortController.getAbortReason(ctr.signal);

          messages.rejectAll(
            error ?? new Error("Bubble worker exited before responding"),
          );

          this.setState(BubbleState.Exited);

          if (error) {
            exit.reject(error);
          } else {
            exit.resolve();
          }
        },
      );
    });

    this.addEventListener("message", (e: MessageEvent<unknown>) => {
      const msg = e.data;
      if (!isResultMessage(msg)) {
        return;
      }
      switch (msg.type) {
        case BubbleResultType.Success:
          messages.resolve(msg.id);
          return;
        case BubbleResultType.Error: {
          const { name, message, stack } = msg.error;
          const err = new Error(message);
          err.name = name;
          err.stack = stack;
          messages.reject(msg.id, err);
          return;
        }
      }
    });

    this.addEventListener("error", (e) => {
      ctr.abort(
        e.error ?? new Error(`Bubble worker error: ${e.message || "unknown"}`),
      );
    });

    this.addEventListener("messageerror", () => {
      messages.rejectAll(
        new Error("Failed to deserialize message from bubble worker"),
      );
      if (this.currentState !== BubbleState.Running) {
        ctr.abort(
          new Error(
            "Failed to deserialize message from bubble worker before it was running",
          ),
        );
      }
    });

    this.addEventListener("close", () => {
      if (!ctr.signal.aborted) {
        this.setState(BubbleState.Stopping);
        ctr.abort(new Error("Bubble worker closed unexpectedly"));
      }
    });

    this.createdAt = createdAt;
    this.eventHandlers = eventHandlers;
    this.logger = workerLogger;
    this.messages = messages;
    this.ctr = ctr;
    this.exited = exit.promise;
  }

  private send(msg: BubbleControlMessage): Promise<void> {
    const response = this.messages.register(msg.id);
    this.postMessage(msg);

    switch (msg.type) {
      case BubbleControlType.Startup: {
        this.boundSocketPath = msg.bubbleSocketPath;
        break;
      }
      case BubbleControlType.Close: {
        const timeout = setTimeout(() => {
          this.messages.reject(
            msg.id,
            new Error(
              `Bubble worker did not respond to close in ${CLOSE_TIMEOUT_MS}ms`,
            ),
          );
        }, CLOSE_TIMEOUT_MS);

        response
          .finally(() => {
            clearTimeout(timeout);
          })
          .catch(() => {});
        break;
      }
    }

    return response;
  }

  public get state(): BubbleState {
    return this.currentState;
  }

  public get socketPath(): string {
    return this.boundSocketPath;
  }

  private setState(state: BubbleState) {
    if (this.currentState >= state) return;
    this.currentState = state;
    this.eventHandlers.onStateChange(state);
  }

  public start(sourcePath: string, socketPath: string): Promise<void> {
    if (this.currentState !== BubbleState.Idle) {
      return Promise.reject(new Error("Bubble worker has already started"));
    }
    const message = newStartupMessage(
      sourcePath,
      socketPath,
      this.logger.fields,
    );
    const started = this.send(message)
      .then(() => {
        this.setState(BubbleState.Running);
      })
      .catch((err: Error) => {
        this.ctr.abort(err);
        throw err;
      });

    this.setState(BubbleState.Starting);
    return started;
  }

  public stop(force: boolean): Promise<void> {
    switch (this.currentState) {
      case BubbleState.Starting:
      case BubbleState.Idle: {
        this.ctr.abort();
        this.setState(BubbleState.Stopping);
        return this.exited;
      }
      case BubbleState.Running: {
        const closed = this.send(newCloseMessage(force));
        this.setState(BubbleState.Stopping);
        closed
          .then(() => {
            this.ctr.abort();
          })
          .catch((err: Error) => {
            this.ctr.abort(err);
          });
        return closed;
      }
      case BubbleState.Stopping:
      case BubbleState.Exited: {
        return this.exited;
      }
      default: {
        const error = new Error(
          `Unknown bubble worker state: ${this.currentState}`,
        );
        return Promise.reject(error);
      }
    }
  }
}
