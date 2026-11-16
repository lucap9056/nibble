import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { BubbleHandlers } from "@/bubbles/bubble";
import { BubbleState } from "@/bubbles/bubble-state";
import type { BubbleRecord } from "@/manager";
import type { RouteEntry } from "@/router";
import type { LogFields, Logger } from "@/utils/logger";
import { toRoutePath } from "@/utils/path";

const { Starting, Running, Stopping } = BubbleState;
const ROUTES_FAILED = "set routes failed";

class FakeBubble {
  public static instances = new Map<string, FakeBubble>();
  private readonly handlers: BubbleHandlers;

  constructor(bubbleName: string, handlers: BubbleHandlers) {
    this.handlers = handlers;
    FakeBubble.instances.set(bubbleName, this);
  }

  public start() {
    return Promise.resolve();
  }

  public stop() {
    return Promise.resolve();
  }

  public emit(state: BubbleState, socketPath = "") {
    this.handlers.onStateChange({ id: "", socketPath }, state);
  }
}

mock.module("@/bubbles", () => ({
  // biome-ignore lint/style/useNamingConvention: keys must match the real module's exports
  Bubble: FakeBubble,
  // biome-ignore lint/style/useNamingConvention: keys must match the real module's exports
  BubbleState,
}));
const { BubbleManager, BubbleOption } = await import("@/manager");
const { Enabled, Routing } = BubbleOption;

const alphaName = "alpha";
const betaName = "beta";
const gammaName = "gamma";
const alphaRoutePath = toRoutePath(alphaName);
const betaRoutePath = toRoutePath(betaName);

const alpha: BubbleRecord = {
  bubbleName: alphaName,
  snapshotPath: "/alpha.js",
  snapshotHash: "hash",
  options: Enabled | Routing,
};
const beta: BubbleRecord = {
  bubbleName: betaName,
  snapshotPath: "/beta.js",
  snapshotHash: "hash",
  options: Enabled | Routing,
};
const gamma: BubbleRecord = {
  bubbleName: gammaName,
  snapshotPath: "/gamma.js",
  snapshotHash: "hash",
  options: Enabled | Routing,
};
const unroutedAlpha: BubbleRecord = { ...alpha, options: Enabled };
const unroutedBeta: BubbleRecord = { ...beta, options: Enabled };
const unroutedGamma: BubbleRecord = { ...gamma, options: Enabled };

interface RoutesCall {
  routes: RouteEntry[];
  settle: PromiseWithResolvers<void>;
}

let calls: RoutesCall[] = [];
const logError = mock((_msg: string, _fields?: LogFields) => {});
const logger: Logger = {
  fields: {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: logError,
  with: () => logger,
};

const onRoutesChange = (routes: RouteEntry[]) => {
  const settle = Promise.withResolvers<void>();
  calls.push({ routes, settle });
  return settle.promise;
};

beforeEach(() => {
  calls = [];
  FakeBubble.instances.clear();
  logError.mockClear();
});

test("sends routes once for a single change", async () => {
  const manager = new BubbleManager({ onRoutesChange }, logger);
  manager.sync(alpha);
  const alphaBubble = FakeBubble.instances.get(alphaName);

  alphaBubble?.emit(Running, "/alpha-1.sock");
  await Bun.sleep(0);

  const expectedRoutes = [
    { routePath: alphaRoutePath, socketPath: "/alpha-1.sock" },
  ];
  expect(calls).toHaveLength(1);
  expect(calls[0]?.routes).toEqual(expectedRoutes);
});

test("merges changes while in flight into one trailing send", async () => {
  const manager = new BubbleManager({ onRoutesChange }, logger);
  manager.sync(alpha);
  manager.sync(beta);
  const alphaBubble = FakeBubble.instances.get(alphaName);
  const betaBubble = FakeBubble.instances.get(betaName);

  alphaBubble?.emit(Running, "/alpha-1.sock");
  betaBubble?.emit(Running, "/beta-1.sock");
  alphaBubble?.emit(Running, "/alpha-2.sock");
  betaBubble?.emit(Stopping);
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);

  calls[0]?.settle.resolve();
  await Bun.sleep(0);
  const expectedRoutes = [
    { routePath: alphaRoutePath, socketPath: "/alpha-2.sock" },
  ];
  expect(calls).toHaveLength(2);
  expect(calls[1]?.routes).toEqual(expectedRoutes);

  calls[1]?.settle.resolve();
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
});

test("keeps sending after the handler rejects", async () => {
  const manager = new BubbleManager({ onRoutesChange }, logger);
  manager.sync(alpha);
  manager.sync(beta);
  const alphaBubble = FakeBubble.instances.get(alphaName);
  const betaBubble = FakeBubble.instances.get(betaName);

  alphaBubble?.emit(Running, "/alpha-1.sock");
  betaBubble?.emit(Running, "/beta-1.sock");
  await Bun.sleep(0);

  const failure = new Error("router unavailable");
  calls[0]?.settle.reject(failure);
  await Bun.sleep(0);
  const expectedRoutes = [
    { routePath: alphaRoutePath, socketPath: "/alpha-1.sock" },
    { routePath: betaRoutePath, socketPath: "/beta-1.sock" },
  ];
  expect(logError).toHaveBeenCalledWith(ROUTES_FAILED, { err: failure });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.routes).toEqual(expectedRoutes);

  calls[1]?.settle.resolve();
  await Bun.sleep(0);
  alphaBubble?.emit(Running, "/alpha-2.sock");
  await Bun.sleep(0);
  expect(calls).toHaveLength(3);
});

test("recovers when the handler throws synchronously", async () => {
  const failure = new Error("sync failure");
  let throwOnce = true;
  const manager = new BubbleManager(
    {
      onRoutesChange: (routes) => {
        if (throwOnce) {
          throwOnce = false;
          throw failure;
        }
        return onRoutesChange(routes);
      },
    },
    logger,
  );
  manager.sync(alpha);
  const alphaBubble = FakeBubble.instances.get(alphaName);

  alphaBubble?.emit(Running, "/alpha-1.sock");
  await Bun.sleep(0);
  expect(logError).toHaveBeenCalledWith(ROUTES_FAILED, { err: failure });

  alphaBubble?.emit(Running, "/alpha-2.sock");
  await Bun.sleep(0);
  const expectedRoutes = [
    { routePath: alphaRoutePath, socketPath: "/alpha-2.sock" },
  ];
  expect(calls).toHaveLength(1);
  expect(calls[0]?.routes).toEqual(expectedRoutes);
});

test("skips changes that leave the route table unchanged", async () => {
  const manager = new BubbleManager({ onRoutesChange }, logger);
  manager.sync(alpha);
  manager.sync(unroutedBeta);
  manager.sync(gamma);
  const alphaBubble = FakeBubble.instances.get(alphaName);
  const betaBubble = FakeBubble.instances.get(betaName);
  const gammaBubble = FakeBubble.instances.get(gammaName);

  alphaBubble?.emit(Running, "/alpha-1.sock");
  await Bun.sleep(0);
  calls[0]?.settle.resolve();
  await Bun.sleep(0);

  alphaBubble?.emit(Running, "/alpha-1.sock");
  betaBubble?.emit(Running, "/beta-1.sock");
  gammaBubble?.emit(Starting);
  gammaBubble?.emit(Stopping);
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
});

test("sends routes when routing is toggled on a running bubble", async () => {
  const manager = new BubbleManager({ onRoutesChange }, logger);
  manager.sync(unroutedAlpha);
  const alphaBubble = FakeBubble.instances.get(alphaName);
  alphaBubble?.emit(Running, "/alpha-1.sock");
  await Bun.sleep(0);
  expect(calls).toHaveLength(0);

  manager.sync(alpha);
  await Bun.sleep(0);
  const expectedRoutes = [
    { routePath: alphaRoutePath, socketPath: "/alpha-1.sock" },
  ];
  expect(calls).toHaveLength(1);
  expect(calls[0]?.routes).toEqual(expectedRoutes);
  calls[0]?.settle.resolve();
  await Bun.sleep(0);

  manager.sync(unroutedAlpha);
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.routes).toEqual([]);
  calls[1]?.settle.resolve();
  await Bun.sleep(0);

  manager.sync(unroutedGamma);
  manager.sync(gamma);
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
});

test("removes routes on disable and ignores the stopped bubble after re-enable", async () => {
  const disabledAlpha: BubbleRecord = { ...alpha, options: 0 };
  const manager = new BubbleManager({ onRoutesChange }, logger);
  manager.sync(alpha);
  const oldBubble = FakeBubble.instances.get(alphaName);
  oldBubble?.emit(Running, "/alpha-1.sock");
  await Bun.sleep(0);
  calls[0]?.settle.resolve();
  await Bun.sleep(0);

  manager.sync(disabledAlpha);
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.routes).toEqual([]);
  calls[1]?.settle.resolve();
  await Bun.sleep(0);

  manager.sync(alpha);
  const newBubble = FakeBubble.instances.get(alphaName);
  newBubble?.emit(Running, "/alpha-2.sock");
  await Bun.sleep(0);
  calls[2]?.settle.resolve();
  await Bun.sleep(0);

  oldBubble?.emit(Stopping);
  oldBubble?.emit(Running, "/alpha-1.sock");
  await Bun.sleep(0);
  const expectedRoutes = [
    { routePath: alphaRoutePath, socketPath: "/alpha-2.sock" },
  ];
  expect(calls).toHaveLength(3);
  expect(calls[2]?.routes).toEqual(expectedRoutes);
});

test("stop halts bubbles, suppresses route sends and rejects further syncs", async () => {
  const manager = new BubbleManager({ onRoutesChange }, logger);
  manager.sync(alpha);
  const alphaBubble = FakeBubble.instances.get(alphaName);
  const stopSpy = spyOn(alphaBubble as FakeBubble, "stop");

  await manager.stop(false);
  expect(stopSpy).toHaveBeenCalledWith(false);

  alphaBubble?.emit(Running, "/alpha-1.sock");
  await Bun.sleep(0);
  expect(calls).toHaveLength(0);
  await expect(manager.sync(beta)).rejects.toThrow("BubbleManager is stopped");
});
