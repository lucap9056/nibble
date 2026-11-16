import { Bubble, BubbleState } from "@/bubbles";
import type { RouteEntry } from "@/router";
import type { Logger } from "@/utils/logger";
import { toRoutePath } from "@/utils/path";

export enum BubbleOption {
  Enabled = 1 << 0,
  Routing = 1 << 1,
}

export type BubbleRecord = {
  bubbleName: string;
  snapshotPath: string;
  snapshotHash: string;
  options: number;
};

interface ActiveBubbleSession {
  snapshotHash: string;
  createdAt: number;
  bubble: Bubble;
}

export interface BubbleManagerHandlers {
  onRoutesChange: (routes: RouteEntry[]) => Promise<void>;
}

export const canActivateBubble = ({ options }: BubbleRecord): boolean => {
  return Boolean(options & BubbleOption.Enabled);
};

const canRouteBubble = ({ options }: BubbleRecord): boolean => {
  return Boolean(options & BubbleOption.Routing);
};

export class BubbleManager {
  private readonly eventHandlers: BubbleManagerHandlers;
  private readonly logger: Logger;
  private readonly bubbleSessions = new Map<string, ActiveBubbleSession>();
  private readonly bubbleSockets = new Map<string, string>();
  private readonly routableBubbles = new Set<string>();
  private routing?: Promise<void>;
  private routesDirty = false;
  private closed = false;

  constructor(eventHandlers: BubbleManagerHandlers, logger: Logger) {
    this.eventHandlers = eventHandlers;
    this.logger = logger;
  }

  private flushRoutes() {
    if (this.closed) {
      return;
    }
    if (this.routing) {
      this.routesDirty = true;
      return;
    }

    const routes: RouteEntry[] = [];
    for (const [bubbleName, socketPath] of this.bubbleSockets) {
      if (!this.routableBubbles.has(bubbleName)) {
        continue;
      }
      const routePath = toRoutePath(bubbleName);
      routes.push({ routePath, socketPath });
    }

    this.routing = Promise.resolve()
      .then(() => this.eventHandlers.onRoutesChange(routes))
      .catch((error) => {
        this.logger.error("set routes failed", { err: error });
      })
      .finally(() => {
        this.routing = undefined;
        if (this.routesDirty) {
          this.routesDirty = false;
          this.flushRoutes();
        }
      });
  }

  public sync(record: BubbleRecord): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("BubbleManager is stopped"));
    }
    const { bubbleName, snapshotPath, snapshotHash } = record;
    if (!canActivateBubble(record)) {
      const existingSession = this.bubbleSessions.get(bubbleName);
      if (existingSession) {
        this.bubbleSessions.delete(bubbleName);
        existingSession.bubble.stop(false).catch((err) => {
          this.logger.error("bubble stop failed", { bubble: bubbleName, err });
        });
      }
      const wasRouted =
        this.bubbleSockets.delete(bubbleName) &&
        this.routableBubbles.has(bubbleName);
      this.routableBubbles.delete(bubbleName);
      if (wasRouted) {
        this.flushRoutes();
      }
      return Promise.resolve();
    }

    const routable = canRouteBubble(record);
    if (routable !== this.routableBubbles.has(bubbleName)) {
      if (routable) {
        this.routableBubbles.add(bubbleName);
      } else {
        this.routableBubbles.delete(bubbleName);
      }
      if (this.bubbleSockets.has(bubbleName)) {
        this.flushRoutes();
      }
    }

    const createdAt = Date.now();
    const existingSession = this.bubbleSessions.get(bubbleName);
    if (existingSession) {
      const { bubble, snapshotHash: activeHash } = existingSession;
      if (snapshotHash === activeHash && bubble.state === BubbleState.Running) {
        return Promise.resolve();
      }
      const started = bubble.start(snapshotPath, createdAt);
      this.bubbleSessions.set(bubbleName, { createdAt, bubble, snapshotHash });
      return started;
    }

    const bubble = new Bubble(
      bubbleName,
      {
        onStateChange: ({ socketPath }, state) => {
          if (this.bubbleSessions.get(bubbleName)?.bubble !== bubble) {
            return;
          }
          switch (state) {
            case BubbleState.Running:
              if (this.bubbleSockets.get(bubbleName) === socketPath) {
                return;
              }
              this.bubbleSockets.set(bubbleName, socketPath);
              break;
            default:
              if (!this.bubbleSockets.delete(bubbleName)) {
                return;
              }
          }
          if (this.routableBubbles.has(bubbleName)) {
            this.flushRoutes();
          }
        },
      },
      this.logger,
    );

    this.bubbleSessions.set(bubbleName, { bubble, createdAt, snapshotHash });

    return bubble.start(snapshotPath, createdAt);
  }

  public async stop(force: boolean): Promise<void> {
    this.closed = true;
    const sessions = this.bubbleSessions.values().toArray();
    this.bubbleSessions.clear();
    this.bubbleSockets.clear();
    this.routableBubbles.clear();

    const errs = await Promise.allSettled(
      sessions.map(({ bubble }) => bubble.stop(force)),
    ).then((results) =>
      results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason as Error),
    );

    if (errs.length > 0) {
      throw new AggregateError(errs, "Failed to stop some bubbles");
    }
  }
}
