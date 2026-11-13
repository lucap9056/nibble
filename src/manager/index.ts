import { Bubble, BubbleState } from "@/bubbles";
import config from "@/config";
import type { RouteEntry } from "@/router";
import { BubbleOption, type BubbleRecord } from "@/storage";
import { toRoutePath } from "@/utils/path";

interface ActiveBubbleSession {
  sourceHash: string;
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
  private readonly bubbleSessions = new Map<string, ActiveBubbleSession>();
  private readonly bubbleSockets = new Map<string, string>();
  private readonly routableBubbles = new Set<string>();
  private routing?: Promise<void>;
  private routesDirty = false;

  constructor(eventHandlers: BubbleManagerHandlers) {
    this.eventHandlers = eventHandlers;
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
        console.error("[BubbleManager] Failed to set routes:", error);
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
    const { sourcePath, sourceHash } = record;
    if (!canActivateBubble(record)) {
      const existingSession = this.bubbleSessions.get(sourcePath);
      if (existingSession) {
        this.bubbleSessions.delete(sourcePath);
        existingSession.bubble.stop(false).catch((err) => {
          console.error(err);
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
      const { bubble, sourceHash: activeHash } = existingSession;
      if (sourceHash === activeHash && bubble.state === BubbleState.Running) {
        return Promise.resolve();
      }
      const started = bubble.start(createdAt);
      this.bubbleSessions.set(sourcePath, { createdAt, bubble, sourceHash });
      return started;
    }

    const bubble = new Bubble(sourcePath, {
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
    });

    this.bubbleSessions.set(sourcePath, { bubble, createdAt, sourceHash });

    return bubble.start(createdAt);
  }
}
