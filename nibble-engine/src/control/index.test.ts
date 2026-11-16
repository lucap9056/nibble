import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BubbleState } from "@/bubbles/bubble-state";
import type { BubbleRecord, BubbleStats } from "@/manager";
import type { Logger } from "@/utils/logger";
import { createControlRoutes } from ".";

const ROOT_DIR_PREFIX = path.join(os.tmpdir(), "nibble-control-");
const CREATED_AT = Date.UTC(2026, 10, 16);

let rootDir: string;
let sourceDir: string;
let snapshotDir: string;
let stats: Map<string, BubbleStats>;

const running = (snapshotHash: string, routing: boolean): BubbleStats => ({
  state: BubbleState.Running,
  snapshotHash,
  createdAt: CREATED_AT,
  routing,
  routed: routing,
});

const manager = {
  stats: () => stats,
  sync: mock(({ bubbleName, snapshotHash, routing }: BubbleRecord) => {
    const bubbleStats = running(snapshotHash, routing);
    stats.set(bubbleName, bubbleStats);
    return Promise.resolve();
  }),
  remove: mock((bubbleName: string) => {
    stats.delete(bubbleName);
  }),
  restart: mock((_bubbleName: string) => Promise.resolve()),
};
const logger = { error: () => {} } as unknown as Logger;

beforeEach(async () => {
  rootDir = await mkdtemp(ROOT_DIR_PREFIX);
  sourceDir = path.join(rootDir, "bubbles");
  snapshotDir = path.join(rootDir, "snapshots");
  stats = new Map();
  manager.sync.mockClear();
  manager.remove.mockClear();
  manager.restart.mockClear();
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const writeEntry = (file: string, content = "export default 1;") => {
  const entryPath = path.join(sourceDir, file);
  return Bun.write(entryPath, content);
};

const createRoutes = () =>
  createControlRoutes({ manager, logger, sourceDir, snapshotDir });

const send = async (
  handler: (req: Request) => Promise<Response>,
  method: string,
  url: string,
  payload?: unknown,
) => {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const request = new Request(`http://control${url}`, { method, body });
  const response = await handler(request);

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  return { status: response.status, body: json };
};

test("source endpoints list and inspect bubble entries", async () => {
  await writeEntry("foo.bubble.js");
  await writeEntry("foo.bubble.ts");
  await writeEntry("nested/bar.bubble.ts");

  const routes = createRoutes();
  const { GET: list } = routes["/sources"];
  const { GET } = routes["/sources/*"];

  const listed = await send(list, "GET", "/sources");
  expect(listed.body.sources).toEqual([
    { name: "foo", entry: "foo.bubble.ts" },
    { name: "nested/bar", entry: "nested/bar.bubble.ts" },
  ]);

  const nested = await send(GET, "GET", "/sources/nested/bar");
  expect(nested.body).toEqual({
    name: "nested/bar",
    entry: "nested/bar.bubble.ts",
  });

  const missing = await send(GET, "GET", "/sources/missing");
  expect(missing.status).toBe(404);

  const invalidName = await send(GET, "GET", "/sources/bad%20name");
  expect(invalidName.status).toBe(400);
});

test("bubble endpoints run, inspect, restart and remove bubbles", async () => {
  await writeEntry("foo.bubble.ts");
  const routes = createRoutes();
  const { POST: build } = routes["/snapshots/*"];
  const { GET: list } = routes["/bubbles"];
  const { GET, PUT, POST, DELETE } = routes["/bubbles/*"];

  const built = await send(build, "POST", "/snapshots/foo");
  const { hash: snapshotHash } = built.body;

  const notRunning = await send(GET, "GET", "/bubbles/foo");
  expect(notRunning.status).toBe(404);

  const restartStopped = await send(POST, "POST", "/bubbles/foo");
  expect(restartStopped.status).toBe(404);

  const removeStopped = await send(DELETE, "DELETE", "/bubbles/foo");
  expect(removeStopped.status).toBe(404);

  const withoutHash = await send(PUT, "PUT", "/bubbles/foo", {
    routing: true,
  });
  expect(withoutHash.status).toBe(400);

  const withoutRouting = await send(PUT, "PUT", "/bubbles/foo", {
    snapshotHash,
  });
  expect(withoutRouting.status).toBe(400);

  const unknownHash = await send(PUT, "PUT", "/bubbles/foo", {
    snapshotHash: "nope",
    routing: true,
  });
  expect(unknownHash.status).toBe(404);
  expect(manager.sync).not.toHaveBeenCalled();

  const started = await send(PUT, "PUT", "/bubbles/foo", {
    snapshotHash,
    routing: true,
  });
  const [syncedRecord] = manager.sync.mock.lastCall ?? [];
  expect(started.status).toBe(202);
  expect(syncedRecord).toMatchObject({
    bubbleName: "foo",
    snapshotHash,
    routing: true,
  });
  expect(started.body).toEqual({
    name: "foo",
    route: "/foo",
    state: "running",
    snapshotHash,
    createdAt: "2026-11-16T00:00:00.000Z",
    routing: true,
    routed: true,
  });

  const listed = await send(list, "GET", "/bubbles");
  expect(listed.body.bubbles).toEqual([started.body]);

  const restarted = await send(POST, "POST", "/bubbles/foo");
  expect(restarted.status).toBe(202);
  expect(manager.restart).toHaveBeenCalledWith("foo");

  const removed = await send(DELETE, "DELETE", "/bubbles/foo");
  expect(removed.status).toBe(204);
  expect(manager.remove).toHaveBeenCalledWith("foo");

  const listedAfterRemove = await send(list, "GET", "/bubbles");
  expect(listedAfterRemove.body.bubbles).toEqual([]);
});

test("snapshot endpoints build, list and delete snapshots", async () => {
  await writeEntry("foo.bubble.ts");
  await writeEntry("broken.bubble.ts", "export default (;");

  const routes = createRoutes();
  const { GET, POST, DELETE } = routes["/snapshots/*"];

  const built = await send(POST, "POST", "/snapshots/foo");
  const { hash, createdAt } = built.body;
  expect(built.status).toBe(201);

  const noEntry = await send(POST, "POST", "/snapshots/none");
  expect(noEntry.status).toBe(404);

  const brokenBuild = await send(POST, "POST", "/snapshots/broken");
  expect(brokenBuild.status).toBe(422);

  const listed = await send(GET, "GET", "/snapshots/foo");
  expect(listed.body.snapshots).toEqual([{ hash, createdAt }]);

  const withoutHash = await send(DELETE, "DELETE", "/snapshots/foo");
  expect(withoutHash.status).toBe(400);

  const runningStats = running(hash, true);
  stats.set("foo", runningStats);
  const deleteUrl = `/snapshots/foo?hash=${hash}`;
  const deleteRunning = await send(DELETE, "DELETE", deleteUrl);
  expect(deleteRunning.status).toBe(409);

  stats.clear();
  const deleted = await send(DELETE, "DELETE", deleteUrl);
  expect(deleted.status).toBe(204);

  const deletedAgain = await send(DELETE, "DELETE", deleteUrl);
  expect(deletedAgain.status).toBe(404);
});
