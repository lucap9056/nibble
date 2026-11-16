import { createBubbleRoutes } from "./bubbles";
import { type ControlContext, createSerialQueue } from "./http";
import { createSnapshotRoutes } from "./snapshots";

export type { ControlContext } from "./http";

export const createControlRoutes = (context: ControlContext) => {
  const enqueue = createSerialQueue();
  return {
    ...createBubbleRoutes(context, enqueue),
    ...createSnapshotRoutes(context, enqueue),
  };
};
