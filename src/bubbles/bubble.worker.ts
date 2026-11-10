import { chmod, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertBubble,
  createDefaultNibbleWebSocketContext,
  NIBBLE_HTTP_METHODS,
  type NibbleBubble,
  type NibbleHttpMethod,
  type NibbleWebSocketHandlers,
} from "@lucap9056/nibble";
import type { WebSocketHandler } from "bun";

//
// messages
//
import type {
  BubbleControlMessage,
  CloseMessage,
  StartupMessage,
} from "./bubble-messages";
import {
  BubbleControlType,
  newErrorMessage,
  newSuccessMessage,
} from "./bubble-messages";
import { BubbleResponses } from "./responses";

//
// export modules
//

import * as nibble from "@lucap9056/nibble";
import * as nibbleCors from "@lucap9056/nibble/cors";

Bun.plugin({
  name: "nibble-core",
  setup(build) {
    build.module("@lucap9056/nibble", () => ({
      exports: nibble,
      loader: "object",
    }));
    build.module("@lucap9056/nibble/cors", () => ({
      exports: nibbleCors,
      loader: "object",
    }));
  },
});

//
// Startup
//

let server: Bun.Server<unknown> | undefined;

interface BubbleInfo<T = unknown> {
  bubbleSourcePath: string;
  bubbleSocketPath: string;
  bubble: NibbleBubble<T>;
}

const loadBubble = async (
  bubbleSourcePath: string,
  bubbleSocketPath: string,
): Promise<BubbleInfo> => {
  if (server) {
    throw new Error(`Bubble worker is already running: ${bubbleSourcePath}`);
  }
  const bubble = (await import(bubbleSourcePath)).default;
  assertBubble(bubble);
  return {
    bubbleSourcePath,
    bubbleSocketPath,
    bubble,
  };
};

const tryParseNibbleHttpMethod = (
  value: string,
): NibbleHttpMethod | undefined => {
  const normalized = value.toLowerCase();
  return NIBBLE_HTTP_METHODS.find((method) => method === normalized);
};

const handleUpgrade = async (
  req: Request,
  server: Bun.Server<unknown>,
  upgradeHandler: NonNullable<NibbleWebSocketHandlers<unknown>["upgrade"]>,
): Promise<Response | undefined> => {
  try {
    const result = await upgradeHandler(req);
    if (result instanceof Response) {
      return result;
    }
    if (server.upgrade(req, { data: result })) {
      return;
    }
    return BubbleResponses.badRequest();
  } catch (err) {
    console.error(err);
    return BubbleResponses.internalServerError();
  }
};

const startupServer = async ({ bubbleSocketPath, bubble }: BubbleInfo) => {
  const unix = `${bubbleSocketPath}.temp`;

  const upgradeHandler =
    bubble.handlers.wss?.upgrade ?? createDefaultNibbleWebSocketContext;

  const websocket: WebSocketHandler<unknown> = {};
  if (bubble.handlers.wss) {
    const { onconnect, onmessage, onclose } = bubble.handlers.wss;
    if (onconnect) {
      websocket.open = onconnect;
    }
    if (onmessage) {
      websocket.message = onmessage;
    }
    if (onclose) {
      websocket.close = onclose;
    }
  }

  await Promise.all([
    rm(bubbleSocketPath, { force: true }),
    rm(unix, { force: true }),
    mkdir(path.dirname(bubbleSocketPath), { recursive: true }),
  ]);

  server = Bun.serve({
    unix,
    fetch(req, server) {
      const upgradeHeader = req.headers.get("upgrade")?.toLowerCase();
      if (upgradeHeader === "websocket") {
        if (bubble.handlers.wss) {
          return handleUpgrade(req, server, upgradeHandler);
        }
      } else {
        const method = tryParseNibbleHttpMethod(req.method);
        if (method) {
          const handler = bubble.handlers[method];
          if (handler) {
            return handler(req);
          }
        }
      }

      return BubbleResponses.notFound();
    },
    websocket,
    error(err) {
      console.error(err);
      return BubbleResponses.internalServerError();
    },
  });

  return chmod(unix, 0o666)
    .then(() => rename(unix, bubbleSocketPath))
    .catch((err: Error) => {
      server?.stop(true);
      server = undefined;
      throw err;
    });
};

const handleBubbleStartup = ({
  id,
  bubbleSourcePath,
  bubbleSocketPath,
}: StartupMessage) =>
  loadBubble(bubbleSourcePath, bubbleSocketPath)
    .then(startupServer)
    .then(() => {
      const msg = newSuccessMessage(id);
      self.postMessage(msg);
    })
    .catch((err: Error) => {
      const msg = newErrorMessage(id, err);
      self.postMessage(msg);
    });

//
// Close
//

const handleBubbleClose = async ({ id, force }: CloseMessage) => {
  const timeout = (() => {
    if (server && !force) {
      const s = server;
      return setTimeout(() => s.stop(true), 5000);
    }
    return undefined;
  })();
  const msg = await (server?.stop(force) ?? Promise.resolve())
    .then(() => newSuccessMessage(id))
    .catch((err: Error) => newErrorMessage(id, err));
  if (timeout) {
    clearTimeout(timeout);
  }
  self.postMessage(msg);
  server = undefined;
};

//
self.onmessage = (e: MessageEvent<BubbleControlMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case BubbleControlType.Startup:
      return handleBubbleStartup(msg);
    case BubbleControlType.Close:
      return handleBubbleClose(msg);
  }
};
