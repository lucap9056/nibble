import { createBubbleRoutes } from "./bubbles";
import { type ControlContext, createSerialQueue } from "./http";
import { createSnapshotRoutes } from "./snapshots";
import { createSourceRoutes } from "./sources";

export type { ControlContext } from "./http";

export const createControlRoutes = (context: ControlContext) => {
  const enqueue = createSerialQueue();
  return {
    ...createSourceRoutes(context),
    ...createBubbleRoutes(context, enqueue),
    ...createSnapshotRoutes(context, enqueue),
  };
};
