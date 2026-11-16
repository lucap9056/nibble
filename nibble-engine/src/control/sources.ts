import { BubbleEntryNotFoundError } from "@/snapshots/errors";
import {
  findBubbleEntry,
  listBubbleEntries,
  toRelativePosixPath,
} from "@/utils/path";
import { type ControlContext, handle, parseBubbleName } from "./http";

const SOURCE_PREFIX = "/sources/";

export const createSourceRoutes = ({ sourceDir }: ControlContext) => {
  const toSourceView = (bubbleName: string, entryPath: string) => {
    const entry = toRelativePosixPath(sourceDir, entryPath);
    return { name: bubbleName, entry };
  };

  return {
    "/sources": {
      GET: handle(async () => {
        const entries = await listBubbleEntries(sourceDir);
        const sources = entries.map(({ bubbleName, entryPath }) =>
          toSourceView(bubbleName, entryPath),
        );

        return Response.json({ sources });
      }),
    },

    "/sources/*": {
      GET: handle(async (req) => {
        const bubbleName = parseBubbleName(req, SOURCE_PREFIX);
        const entryPath = await findBubbleEntry(sourceDir, bubbleName);
        if (!entryPath) {
          throw new BubbleEntryNotFoundError(bubbleName);
        }

        const source = toSourceView(bubbleName, entryPath);
        return Response.json(source);
      }),
    },
  };
};
