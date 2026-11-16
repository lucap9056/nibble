import { rm } from "node:fs/promises";
import { readBootstrap } from "@/bootstrap";
import config from "@/config";
import { createControlRoutes } from "@/control";
import { BubbleManager } from "@/manager";
import { RouterProcess } from "@/router";
import { buildSnapshot, resolveSnapshot } from "@/snapshots";
import { createLogger } from "@/utils/logger";

const logger = createLogger("engine");

const bootstrap = await readBootstrap(logger).catch((err) => {
  logger.error("bootstrap failed", { err });
  process.exit(1);
});

const router = new RouterProcess(config.routerBinaryPath);
const manager = new BubbleManager(
  { onRoutesChange: (routes) => router.setRoutes(routes) },
  logger,
);

logger.info("engine starting", { bubbles: bootstrap.bubbles.length });

const { bubbleSourceDir: sourceDir, bubbleSnapshotDir: snapshotDir } = config;
await Promise.all(
  bootstrap.bubbles.map(({ name: bubbleName, snapshotHash, routing }) =>
    (snapshotHash === undefined
      ? buildSnapshot(sourceDir, bubbleName, snapshotDir)
      : resolveSnapshot(bubbleName, snapshotDir, snapshotHash)
    )
      .then(({ snapshotPath, snapshotHash: resolvedHash }) =>
        manager.sync({
          bubbleName,
          snapshotPath,
          snapshotHash: resolvedHash,
          routing,
        }),
      )
      .catch((err) => {
        logger.error("bubble sync failed", {
          bubble: bubbleName,
          snapshotHash,
          err,
        });
      }),
  ),
);

const { controlSocketPath } = config;
await rm(controlSocketPath, { force: true });
const controlRoutes = createControlRoutes({
  manager,
  logger,
  sourceDir,
  snapshotDir,
});
const controlServer = Bun.serve({
  unix: controlSocketPath,
  routes: controlRoutes,
  fetch: () => new Response("Not Found", { status: 404 }),
});
logger.info("control listening", { socket: controlSocketPath });

let shutdownReason: string | undefined;
const shutdownRequest = Promise.withResolvers<void>();
const requestShutdown = (reason: string) => {
  shutdownReason ??= reason;
  shutdownRequest.resolve();
};
bootstrap.stdinClosed.then(() => requestShutdown("stdin closed"));
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

let exitCode = 0;
try {
  await router.start(config.routerListen);
  logger.info("router listening", { listen: config.routerListen });
  await Promise.race([shutdownRequest.promise, router.exited]);
} catch (err) {
  if (shutdownReason === undefined) {
    exitCode = 1;
    logger.error("router failed", { err });
  }
}

logger.info("engine shutting down", {
  reason: shutdownReason ?? "router exited",
});
await controlServer
  .stop()
  .catch((err) => logger.error("control stop failed", { err }));
await router
  .stop(false)
  .catch((err) => logger.error("router stop failed", { err }));
await manager
  .stop(false)
  .catch((err) => logger.error("bubbles stop failed", { err }));
logger.info("engine stopped", { exitCode });
process.exit(exitCode);
