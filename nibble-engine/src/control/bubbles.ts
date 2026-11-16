import { BubbleState } from "@/bubbles";
import { isValidBubbleOptions } from "@/expected-bubble";
import { BubbleOption, type BubbleStats } from "@/manager";
import { resolveSnapshot } from "@/snapshots";
import {
  findBubbleEntry,
  listBubbleEntries,
  toRelativePosixPath,
  toRoutePath,
} from "@/utils/path";
import {
  type ControlContext,
  ControlError,
  handle,
  parseBubbleName,
  type SerialQueue,
} from "./http";

const BUBBLE_PREFIX = "/bubbles/";

const toStatusView = ({
  state,
  snapshotHash,
  createdAt,
  routing,
  routed,
}: BubbleStats) => {
  const stateName = BubbleState[state].toLowerCase();
  const createdAtIso = new Date(createdAt).toISOString();

  return {
    state: stateName,
    snapshotHash,
    createdAt: createdAtIso,
    routing,
    routed,
  };
};

const toBubbleView = (
  sourceDir: string,
  bubbleName: string,
  entryPath: string | undefined,
  status: BubbleStats | undefined,
) => {
  const route = toRoutePath(bubbleName);
  const entry = entryPath ? toRelativePosixPath(sourceDir, entryPath) : null;
  const statusView = status ? toStatusView(status) : null;

  return { name: bubbleName, route, entry, status: statusView };
};

const parseSyncBody = async (req: Request) => {
  const body = await req.json().catch(() => undefined);
  const { hash, options } = (body ?? {}) as Record<string, unknown>;

  if (!isValidBubbleOptions(options)) {
    throw new ControlError(400, "options must be a valid BubbleOption mask");
  }
  if (hash !== undefined && typeof hash !== "string") {
    throw new ControlError(400, "hash must be a string");
  }

  return { hash, options };
};

export const createBubbleRoutes = (
  { manager, logger, sourceDir, snapshotDir }: ControlContext,
  enqueue: SerialQueue,
) => {
  const viewBubble = async (bubbleName: string) => {
    const entryPath = await findBubbleEntry(sourceDir, bubbleName);
    const status = manager.stats().get(bubbleName);

    return toBubbleView(sourceDir, bubbleName, entryPath, status);
  };

  const logStartFailure = (bubbleName: string, err: unknown) =>
    logger.error("bubble start failed", { bubble: bubbleName, err });

  return {
    "/bubbles": {
      GET: handle(async () => {
        const entries = await listBubbleEntries(sourceDir);
        const entryPairs = entries.map(
          ({ bubbleName, entryPath }) => [bubbleName, entryPath] as const,
        );
        const entryPaths = new Map(entryPairs);

        const stats = manager.stats();
        const knownNames = [...entryPaths.keys(), ...stats.keys()];
        const bubbleNames = new Set(knownNames)
          .values()
          .toArray()
          .sort((a, b) => a.localeCompare(b));

        const bubbles = bubbleNames.map((bubbleName) => {
          const entryPath = entryPaths.get(bubbleName);
          const status = stats.get(bubbleName);

          return toBubbleView(sourceDir, bubbleName, entryPath, status);
        });

        return Response.json({ bubbles });
      }),
    },

    "/bubbles/*": {
      GET: handle(async (req) => {
        const bubbleName = parseBubbleName(req, BUBBLE_PREFIX);
        const bubble = await viewBubble(bubbleName);
        if (!bubble.entry && !bubble.status) {
          throw new ControlError(404, `Bubble not found: ${bubble.name}`);
        }

        return Response.json(bubble);
      }),

      PUT: handle(async (req) => {
        const bubbleName = parseBubbleName(req, BUBBLE_PREFIX);
        const { hash, options } = await parseSyncBody(req);

        await enqueue(bubbleName, async () => {
          if (!(options & BubbleOption.Enabled)) {
            manager.disable(bubbleName);
            return;
          }

          const { snapshotPath, snapshotHash } = await resolveSnapshot(
            sourceDir,
            bubbleName,
            snapshotDir,
            hash,
          );

          manager
            .sync({ bubbleName, snapshotPath, snapshotHash, options })
            .catch((err) => logStartFailure(bubbleName, err));
        });

        const bubble = await viewBubble(bubbleName);
        return Response.json(bubble, { status: 202 });
      }),

      POST: handle(async (req) => {
        const bubbleName = parseBubbleName(req, BUBBLE_PREFIX);

        await enqueue(bubbleName, async () => {
          if (!manager.stats().has(bubbleName)) {
            throw new ControlError(404, `Bubble is not active: ${bubbleName}`);
          }

          manager
            .restart(bubbleName)
            .catch((err) => logStartFailure(bubbleName, err));
        });

        const bubble = await viewBubble(bubbleName);
        return Response.json(bubble, { status: 202 });
      }),
    },
  };
};
