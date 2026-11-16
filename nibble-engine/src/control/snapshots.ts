import { buildSnapshot, deleteSnapshot, listSnapshots } from "@/snapshots";
import {
  type ControlContext,
  ControlError,
  handle,
  parseBubbleName,
  type SerialQueue,
} from "./http";

const SNAPSHOT_PREFIX = "/snapshots/";

export const createSnapshotRoutes = (
  { manager, sourceDir, snapshotDir }: ControlContext,
  enqueue: SerialQueue,
) => ({
  "/snapshots/*": {
    GET: handle(async (req) => {
      const bubbleName = parseBubbleName(req, SNAPSHOT_PREFIX);
      const snapshots = await listSnapshots(bubbleName, snapshotDir);

      const snapshotViews = snapshots.map(({ snapshotHash, createdAt }) => {
        const createdAtIso = createdAt.toISOString();
        return { hash: snapshotHash, createdAt: createdAtIso };
      });

      return Response.json({ snapshots: snapshotViews });
    }),

    POST: handle(async (req) => {
      const bubbleName = parseBubbleName(req, SNAPSHOT_PREFIX);
      const { snapshotHash, createdAt } = await buildSnapshot(
        sourceDir,
        bubbleName,
        snapshotDir,
      );

      const createdAtIso = createdAt.toISOString();
      return Response.json(
        { hash: snapshotHash, createdAt: createdAtIso },
        { status: 201 },
      );
    }),

    DELETE: handle(async (req) => {
      const bubbleName = parseBubbleName(req, SNAPSHOT_PREFIX);
      const snapshotHash = new URL(req.url).searchParams.get("hash");
      if (!snapshotHash) {
        throw new ControlError(400, "hash query parameter is required");
      }

      await enqueue(bubbleName, async () => {
        if (manager.stats().get(bubbleName)?.snapshotHash === snapshotHash) {
          throw new ControlError(409, `Snapshot is active: ${snapshotHash}`);
        }

        await deleteSnapshot(bubbleName, snapshotDir, snapshotHash);
      });

      return new Response(null, { status: 204 });
    }),
  },
});
