import { relative, sep } from "node:path";
import { readBootstrap } from "@/bootstrap";
import config from "@/config";
import { BubbleManager } from "@/manager";
import { RouterProcess } from "@/router";
import { resolveSnapshot } from "@/snapshots";
import { createLogger } from "@/utils/logger";
import { toBubbleName } from "@/utils/path";

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
  bootstrap.bubbles
    .filter(({ options }) => options !== 0)
    .map(({ path, hash, options }) =>
      Promise.try(() => toBubbleName(sourceDir, path))
        .then((bubbleName) =>
          resolveSnapshot(sourceDir, bubbleName, snapshotDir, hash),
        )
        .then(({ bubbleName, snapshotPath, snapshotHash }) =>
          manager.sync({ bubbleName, snapshotPath, snapshotHash, options }),
        )
        .catch((err) => {
          const bubble = relative(sourceDir, path).split(sep).join("/");
          logger.error("bubble sync failed", { bubble, hash, err });
        }),
    ),
);

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
await router
  .stop(false)
  .catch((err) => logger.error("router stop failed", { err }));
await manager
  .stop(false)
  .catch((err) => logger.error("bubbles stop failed", { err }));
logger.info("engine stopped", { exitCode });
process.exit(exitCode);
