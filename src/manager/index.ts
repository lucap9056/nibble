import { Bubble, BubbleState } from "@/bubbles";
import config from "@/config";
import type { RouteEntry } from "@/router";
import type { Logger } from "@/utils/logger";
import { toRelativePosixPath, toRoutePath } from "@/utils/path";

export enum BubbleOption {
  Enabled = 1 << 0,
  Routing = 1 << 1,
}

export type BubbleRecord = {
  sourcePath: string;
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

  constructor(eventHandlers: BubbleManagerHandlers, logger: Logger) {
    this.eventHandlers = eventHandlers;
    this.logger = logger;
  }

  private flushRoutes() {
    if (this.routing) {
      this.routesDirty = true;
      return;
    }

    const routes: RouteEntry[] = [];
    for (const [sourcePath, socketPath] of this.bubbleSockets) {
      if (!this.routableBubbles.has(sourcePath)) {
        continue;
      }
      const routePath = toRoutePath(config.bubbleSourceDir, sourcePath);
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
    const { sourcePath, snapshotPath, snapshotHash } = record;
    if (!canActivateBubble(record)) {
      const existingSession = this.bubbleSessions.get(sourcePath);
      if (existingSession) {
        this.bubbleSessions.delete(sourcePath);
        existingSession.bubble.stop(false).catch((err) => {
          const bubble = toRelativePosixPath(
            config.bubbleSourceDir,
            sourcePath,
          );
          this.logger.error("bubble stop failed", { bubble, err });
        });
      }
      const wasRouted =
        this.bubbleSockets.delete(sourcePath) &&
        this.routableBubbles.has(sourcePath);
      this.routableBubbles.delete(sourcePath);
      if (wasRouted) {
        this.flushRoutes();
      }
      return Promise.resolve();
    }

    const routable = canRouteBubble(record);
    if (routable !== this.routableBubbles.has(sourcePath)) {
      if (routable) {
        this.routableBubbles.add(sourcePath);
      } else {
        this.routableBubbles.delete(sourcePath);
      }
      if (this.bubbleSockets.has(sourcePath)) {
        this.flushRoutes();
      }
    }

    const createdAt = Date.now();
    const existingSession = this.bubbleSessions.get(sourcePath);
    if (existingSession) {
      const { bubble, snapshotHash: activeHash } = existingSession;
      if (snapshotHash === activeHash && bubble.state === BubbleState.Running) {
        return Promise.resolve();
      }
      const started = bubble.start(snapshotPath, createdAt);
      this.bubbleSessions.set(sourcePath, { createdAt, bubble, snapshotHash });
      return started;
    }

    const bubble = new Bubble(
      sourcePath,
      {
        onStateChange: ({ socketPath }, state) => {
          if (this.bubbleSessions.get(sourcePath)?.bubble !== bubble) {
            return;
          }
          switch (state) {
            case BubbleState.Running:
              if (this.bubbleSockets.get(sourcePath) === socketPath) {
                return;
              }
              this.bubbleSockets.set(sourcePath, socketPath);
              break;
            default:
              if (!this.bubbleSockets.delete(sourcePath)) {
                return;
              }
          }
          if (this.routableBubbles.has(sourcePath)) {
            this.flushRoutes();
          }
        },
      },
      this.logger,
    );

    this.bubbleSessions.set(sourcePath, { bubble, createdAt, snapshotHash });

    return bubble.start(snapshotPath, createdAt);
  }
}
