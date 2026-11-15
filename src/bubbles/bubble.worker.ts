import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import {
  assertBubble,
  createDefaultNibbleWebSocketContext,
  NIBBLE_HTTP_METHODS,
  type NibbleBubble,
  type NibbleHttpMethod,
  type NibbleWebSocketHandlers,
} from "@lucap9056/nibble";
import type { WebSocketHandler } from "bun";
import { createLogger } from "@/utils/logger";

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

(() => {
  const workerScope = self;
  const postResult = workerScope.postMessage.bind(workerScope);

  let bubbleLogger = createLogger("bubble");
  console.log = (...args: unknown[]) => bubbleLogger.info(format(...args));
  console.info = (...args: unknown[]) => bubbleLogger.info(format(...args));
  console.debug = (...args: unknown[]) => bubbleLogger.debug(format(...args));
  console.warn = (...args: unknown[]) => bubbleLogger.warn(format(...args));
  console.error = (...args: unknown[]) => bubbleLogger.error(format(...args));

  process.chdir = () => {
    throw new Error("process.chdir is not allowed in bubble worker");
  };

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
    bubbleSnapshotPath: string;
    bubbleSocketPath: string;
    bubble: NibbleBubble<T>;
  }

  const loadBubble = async (
    bubbleSnapshotPath: string,
    bubbleSocketPath: string,
  ): Promise<BubbleInfo> => {
    if (server) {
      throw new Error(
        `Bubble worker is already running: ${bubbleSnapshotPath}`,
      );
    }
    const bubble = (await import(bubbleSnapshotPath)).default;
    assertBubble(bubble);
    return {
      bubbleSnapshotPath,
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
      bubbleLogger.error("upgrade handler failed", { err });
      return BubbleResponses.internalServerError();
    }
  };

  const startupServer = async ({ bubbleSocketPath, bubble }: BubbleInfo) => {
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
      mkdir(path.dirname(bubbleSocketPath), { recursive: true }),
    ]);

    server = Bun.serve({
      unix: bubbleSocketPath,
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
        bubbleLogger.error("request handler failed", { err });
        return BubbleResponses.internalServerError();
      },
    });

    return chmod(bubbleSocketPath, 0o666).catch((err: Error) => {
      server?.stop(true);
      server = undefined;
      throw err;
    });
  };

  const handleBubbleStartup = ({
    id,
    bubbleSnapshotPath,
    bubbleSocketPath,
    logFields,
  }: StartupMessage) => {
    bubbleLogger = createLogger("bubble", logFields);
    return loadBubble(bubbleSnapshotPath, bubbleSocketPath)
      .then(startupServer)
      .then(() => {
        const msg = newSuccessMessage(id);
        postResult(msg);
      })
      .catch((err: Error) => {
        const msg = newErrorMessage(id, err);
        postResult(msg);
      });
  };

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
    postResult(msg);
    server = undefined;
  };

  //
  workerScope.addEventListener(
    "message",
    (e: MessageEvent<BubbleControlMessage>) => {
      if (!e.isTrusted) {
        return;
      }
      const msg = e.data;

      switch (msg.type) {
        case BubbleControlType.Startup:
          return handleBubbleStartup(msg);
        case BubbleControlType.Close:
          return handleBubbleClose(msg);
      }
    },
  );
})();
