import { BubbleState } from "@/bubbles";
import type { BubbleStats } from "@/manager";
import { resolveSnapshot } from "@/snapshots";
import { toRoutePath } from "@/utils/path";
import {
  type ControlContext,
  ControlError,
  handle,
  parseBubbleName,
  type SerialQueue,
} from "./http";

const BUBBLE_PREFIX = "/bubbles/";

const toBubbleView = (
  bubbleName: string,
  { state, snapshotHash, createdAt, routing, routed }: BubbleStats,
) => {
  const route = toRoutePath(bubbleName);
  const stateName = BubbleState[state].toLowerCase();
  const createdAtIso = new Date(createdAt).toISOString();

  return {
    name: bubbleName,
    route,
    state: stateName,
    snapshotHash,
    createdAt: createdAtIso,
    routing,
    routed,
  };
};

const parseSyncBody = async (req: Request) => {
  const body = await req.json().catch(() => undefined);
  const { snapshotHash, routing } = (body ?? {}) as Record<string, unknown>;

  if (typeof snapshotHash !== "string" || snapshotHash.length === 0) {
    throw new ControlError(400, "snapshotHash must be a non-empty string");
  }
  if (typeof routing !== "boolean") {
    throw new ControlError(400, "routing must be a boolean");
  }

  return { snapshotHash, routing };
};

export const createBubbleRoutes = (
  { manager, logger, snapshotDir }: ControlContext,
  enqueue: SerialQueue,
) => {
  const requireStats = (bubbleName: string): BubbleStats => {
    const stats = manager.stats().get(bubbleName);
    if (!stats) {
      throw new ControlError(404, `Bubble is not running: ${bubbleName}`);
    }

    return stats;
  };

  const viewBubble = (bubbleName: string) => {
    const stats = requireStats(bubbleName);
    return toBubbleView(bubbleName, stats);
  };

  const logStartFailure = (bubbleName: string, err: unknown) =>
    logger.error("bubble start failed", { bubble: bubbleName, err });

  return {
    "/bubbles": {
      GET: handle(async () => {
        const bubbles = manager
          .stats()
          .entries()
          .map(([bubbleName, stats]) => toBubbleView(bubbleName, stats))
          .toArray()
          .sort((a, b) => a.name.localeCompare(b.name));

        return Response.json({ bubbles });
      }),
    },

    "/bubbles/*": {
      GET: handle(async (req) => {
        const bubbleName = parseBubbleName(req, BUBBLE_PREFIX);
        const bubble = viewBubble(bubbleName);

        return Response.json(bubble);
      }),

      PUT: handle(async (req) => {
        const bubbleName = parseBubbleName(req, BUBBLE_PREFIX);
        const { snapshotHash, routing } = await parseSyncBody(req);

        await enqueue(bubbleName, async () => {
          const { snapshotPath } = await resolveSnapshot(
            bubbleName,
            snapshotDir,
            snapshotHash,
          );

          manager
            .sync({ bubbleName, snapshotPath, snapshotHash, routing })
            .catch((err) => logStartFailure(bubbleName, err));
        });

        const bubble = viewBubble(bubbleName);
        return Response.json(bubble, { status: 202 });
      }),

      DELETE: handle(async (req) => {
        const bubbleName = parseBubbleName(req, BUBBLE_PREFIX);

        await enqueue(bubbleName, async () => {
          requireStats(bubbleName);
          manager.remove(bubbleName);
        });

        return new Response(null, { status: 204 });
      }),

      POST: handle(async (req) => {
        const bubbleName = parseBubbleName(req, BUBBLE_PREFIX);

        await enqueue(bubbleName, async () => {
          requireStats(bubbleName);
          manager
            .restart(bubbleName)
            .catch((err) => logStartFailure(bubbleName, err));
        });

        const bubble = viewBubble(bubbleName);
        return Response.json(bubble, { status: 202 });
      }),
    },
  };
};
