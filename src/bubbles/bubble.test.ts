import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import config from "@/config";
import type { Logger } from "@/utils/logger";
import type { Bubble as BubbleType } from "./bubble";
import {
  type BubbleControlMessage,
  BubbleControlType,
  newErrorMessage,
  newSuccessMessage,
  type ResultMessage,
} from "./bubble-messages";
import { BubbleState } from "./bubble-state";
import type { BubbleWorker } from "./bubble-worker";

const { Startup, Close } = BubbleControlType;
const { Starting, Running, Stopping, Idle } = BubbleState;

const WAIT_TIMEOUT_MS = 1000;
const SETTLE_MS = 20;
const EXITED_BEFORE_RESPONDING = "Bubble worker exited before responding";
const CLOSED_UNEXPECTEDLY = "Bubble worker closed unexpectedly";

const waitUntil = async (predicate: () => boolean) => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await Bun.sleep(1);
  }
};

class FakeWorker extends EventTarget {
  public static instances: FakeWorker[] = [];
  public static autoReplyClose = false;
  public readonly received: BubbleControlMessage[] = [];
  public terminated = false;

  constructor(_url: URL) {
    super();
    FakeWorker.instances.push(this);
  }

  public postMessage(msg: BubbleControlMessage) {
    this.received.push(msg);
    if (FakeWorker.autoReplyClose && msg.type === Close) {
      const result = newSuccessMessage(msg.id);
      queueMicrotask(() => this.dispatchResult(result));
    }
  }

  public terminate() {
    this.terminated = true;
    const closeEvent = new Event("close");
    queueMicrotask(() => this.dispatchEvent(closeEvent));
  }

  public async waitForMessage(type: BubbleControlType) {
    const isTargetType = (msg: BubbleControlMessage) => msg.type === type;
    const hasTargetType = () => this.received.some(isTargetType);
    await waitUntil(hasTargetType);
    return this.received.findLast(isTargetType) as BubbleControlMessage;
  }

  public async reply(type: BubbleControlType) {
    const msg = await this.waitForMessage(type);
    if (msg.type === Startup) {
      const { bubbleSocketPath } = msg;
      await writeFile(bubbleSocketPath, "");
    }
    const result = newSuccessMessage(msg.id);
    this.dispatchResult(result);
  }

  public async fail(type: BubbleControlType, message: string) {
    const msg = await this.waitForMessage(type);
    const error = new Error(message);
    const result = newErrorMessage(msg.id, error);
    this.dispatchResult(result);
  }

  public crash(message: string) {
    const error = new Error(message);
    const errorEvent = new ErrorEvent("error", { error, message });
    this.dispatchEvent(errorEvent);
  }

  public closeUnexpectedly() {
    const closeEvent = new Event("close");
    this.dispatchEvent(closeEvent);
  }

  private dispatchResult(data: ResultMessage) {
    const resultEvent = new MessageEvent("message", { data });
    this.dispatchEvent(resultEvent);
  }
}

type SpawnedWorker = FakeWorker & Pick<BubbleWorker, "id" | "socketPath">;
type ExpectedEvent = [state: BubbleState, worker: SpawnedWorker];

const OriginalWorker = globalThis.Worker;
globalThis.Worker = FakeWorker as unknown as typeof Worker;
const { Bubble } = await import("./bubble");

const silentLogger: Logger = {
  fields: {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => silentLogger,
};

let activeBubble: BubbleType | undefined;

beforeAll(async () => {
  await mkdir(config.bubbleSocketDir, { recursive: true });
});

afterEach(async () => {
  FakeWorker.autoReplyClose = true;
  const stopped = activeBubble?.stop(true);
  await stopped?.catch(() => {});
  FakeWorker.autoReplyClose = false;
  activeBubble = undefined;
});

afterAll(() => {
  globalThis.Worker = OriginalWorker;
});

const setup = () => {
  const events: { id: string; socketPath: string; state: BubbleState }[] = [];
  let checked = 0;
  const snapshotPath = path.join(config.bubbleSnapshotDir, "test.js");
  const bubble = new Bubble(
    "test",
    {
      onStateChange: ({ id, socketPath }, state) => {
        events.push({ id, socketPath, state });
      },
    },
    silentLogger,
  );
  activeBubble = bubble;

  const start = (createdAt: number) => {
    const started = bubble.start(snapshotPath, createdAt);
    const worker = FakeWorker.instances.at(-1) as SpawnedWorker;
    return { started, worker };
  };

  const run = async (createdAt: number) => {
    const { started, worker } = start(createdAt);
    await worker.reply(Startup);
    await started;
    return worker;
  };

  const expectNext = async (...expected: ExpectedEvent[]) => {
    const expectedCount = checked + expected.length;
    await waitUntil(() => events.length >= expectedCount);
    await Bun.sleep(SETTLE_MS);

    const actualEvents = events.slice(checked);
    const expectedEvents = expected.map(([state, worker]) =>
      state === Idle
        ? { id: "", socketPath: "", state }
        : { id: worker.id, socketPath: worker.socketPath, state },
    );
    expect(actualEvents).toEqual(expectedEvents);
    checked = events.length;
  };

  const expectNoNewEvents = () => expectNext();

  return { bubble, start, run, expectNext, expectNoNewEvents };
};

test("first start emits Starting then Running", async () => {
  const { run, expectNext } = setup();

  const worker = await run(10);
  await expectNext([Starting, worker], [Running, worker]);

  const socketName = path.basename(worker.socketPath);
  expect(worker.id).toBe(socketName);
});

test("newer worker swaps running worker and closes old gracefully", async () => {
  const { run, expectNext, expectNoNewEvents } = setup();

  const first = await run(10);
  await expectNext([Starting, first], [Running, first]);

  const swapped = await run(20);
  await expectNext([Running, swapped]);

  const firstClose = await first.waitForMessage(Close);
  expect(firstClose).toMatchObject({ force: false });
  await first.reply(Close);
  await expectNoNewEvents();
  expect(first.terminated).toBe(true);
});

test("outdated start while running is rejected", async () => {
  const { start, run, expectNext, expectNoNewEvents } = setup();

  const current = await run(20);
  await expectNext([Starting, current], [Running, current]);

  const outdated = start(15);
  await expect(outdated.started).rejects.toThrow(EXITED_BEFORE_RESPONDING);
  expect(outdated.worker.terminated).toBe(true);
  await expectNoNewEvents();
});

test("pending successor takes over after current crashes", async () => {
  const { start, run, expectNext, expectNoNewEvents } = setup();

  const current = await run(20);
  await expectNext([Starting, current], [Running, current]);

  const successor = start(30);
  await expectNoNewEvents();

  current.crash("crashed");
  await expectNext([Starting, successor.worker]);

  await successor.worker.reply(Startup);
  await successor.started;
  await expectNext([Running, successor.worker]);
});

test("crash without successor goes Idle", async () => {
  const { run, expectNext } = setup();

  const worker = await run(10);
  await expectNext([Starting, worker], [Running, worker]);

  worker.crash("crashed");
  await expectNext([Stopping, worker], [Idle, worker]);
});

test("crash during startup rejects with the crash error", async () => {
  const { start, expectNext } = setup();
  const crashMessage = "crashed during startup";

  const crashing = start(10);
  crashing.worker.crash(crashMessage);
  await expect(crashing.started).rejects.toThrow(crashMessage);
  await expectNext(
    [Starting, crashing.worker],
    [Stopping, crashing.worker],
    [Idle, crashing.worker],
  );
});

test("unexpected close during startup rejects and goes Idle", async () => {
  const { start, expectNext } = setup();

  const closing = start(10);
  closing.worker.closeUnexpectedly();
  await expect(closing.started).rejects.toThrow(CLOSED_UNEXPECTEDLY);
  expect(closing.worker.terminated).toBe(true);
  await expectNext(
    [Starting, closing.worker],
    [Stopping, closing.worker],
    [Idle, closing.worker],
  );
});

test("startup failure rejects and goes Idle", async () => {
  const { start, expectNext } = setup();
  const failure = "boom";

  const failing = start(10);
  await failing.worker.fail(Startup, failure);
  await expect(failing.started).rejects.toThrow(failure);
  await expectNext(
    [Starting, failing.worker],
    [Stopping, failing.worker],
    [Idle, failing.worker],
  );
});

test("newer start replaces starting worker", async () => {
  const { start, expectNext } = setup();

  const replaced = start(50);
  const latest = start(70);
  await expect(replaced.started).rejects.toThrow(EXITED_BEFORE_RESPONDING);
  expect(replaced.worker.terminated).toBe(true);

  const outdated = start(60);
  await expect(outdated.started).rejects.toThrow(EXITED_BEFORE_RESPONDING);
  expect(outdated.worker.terminated).toBe(true);
  expect(latest.worker.terminated).toBe(false);

  await latest.worker.reply(Startup);
  await latest.started;
  await expectNext([Starting, replaced.worker], [Running, latest.worker]);
});

test("force stop aborts pending and closes running", async () => {
  const { bubble, start, run, expectNext } = setup();

  const running = await run(10);
  await expectNext([Starting, running], [Running, running]);

  const pending = start(20);
  const stopped = bubble.stop(true);
  await expect(pending.started).rejects.toThrow(EXITED_BEFORE_RESPONDING);

  const runningClose = await running.waitForMessage(Close);
  expect(runningClose).toMatchObject({ force: true });
  await running.reply(Close);
  await stopped;
  expect(pending.worker.terminated).toBe(true);
  expect(running.terminated).toBe(true);
  await expectNext([Stopping, running], [Idle, running]);
});

test("start during graceful stop takes over", async () => {
  const { bubble, run, expectNext } = setup();

  const stopping = await run(10);
  const stopped = bubble.stop(false);
  await stopping.waitForMessage(Close);

  const takeover = await run(20);
  await stopping.reply(Close);
  await stopped;
  expect(takeover.terminated).toBe(false);
  await expectNext(
    [Starting, stopping],
    [Running, stopping],
    [Stopping, stopping],
    [Starting, takeover],
    [Running, takeover],
  );
});

test("graceful stop goes Idle", async () => {
  const { bubble, run, expectNext } = setup();

  const worker = await run(10);
  await expectNext([Starting, worker], [Running, worker]);

  const stopped = bubble.stop(false);
  const workerClose = await worker.waitForMessage(Close);
  expect(workerClose).toMatchObject({ force: false });
  await worker.reply(Close);
  await stopped;
  expect(worker.terminated).toBe(true);
  await expectNext([Stopping, worker], [Idle, worker]);
});
