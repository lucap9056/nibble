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

const manager = {
  stats: () => stats,
  sync: mock((_record: BubbleRecord) => Promise.resolve()),
  disable: mock((_bubbleName: string) => {}),
  restart: mock((_bubbleName: string) => Promise.resolve()),
};
const logger = { error: () => {} } as unknown as Logger;

beforeEach(async () => {
  rootDir = await mkdtemp(ROOT_DIR_PREFIX);
  sourceDir = path.join(rootDir, "bubbles");
  snapshotDir = path.join(rootDir, "snapshots");
  stats = new Map();
  manager.sync.mockClear();
  manager.disable.mockClear();
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const writeEntry = (file: string, content = "export default 1;") => {
  const entryPath = path.join(sourceDir, file);
  return Bun.write(entryPath, content);
};

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

const running = (snapshotHash: string): BubbleStats => ({
  state: BubbleState.Running,
  snapshotHash,
  createdAt: CREATED_AT,
  routing: true,
  routed: true,
});

test("bubble endpoints list, inspect and sync bubbles", async () => {
  await writeEntry("foo.bubble.js");
  await writeEntry("foo.bubble.ts");
  const goneStats = running("old");
  stats.set("gone", goneStats);

  const routes = createControlRoutes({
    manager,
    logger,
    sourceDir,
    snapshotDir,
  });
  const { GET: list } = routes["/bubbles"];
  const { GET, PUT, POST } = routes["/bubbles/*"];

  const listed = await send(list, "GET", "/bubbles");
  expect(listed.body.bubbles).toMatchObject([
    { name: "foo", route: "/foo", entry: "foo.bubble.ts", status: null },
    {
      name: "gone",
      entry: null,
      status: { state: "running", snapshotHash: "old" },
    },
  ]);

  const missing = await send(GET, "GET", "/bubbles/missing");
  expect(missing.status).toBe(404);

  const invalidName = await send(GET, "GET", "/bubbles/bad%20name");
  expect(invalidName.status).toBe(400);

  const restartInactive = await send(POST, "POST", "/bubbles/foo");
  expect(restartInactive.status).toBe(404);

  const invalidOptions = await send(PUT, "PUT", "/bubbles/foo", {
    options: 8,
  });
  expect(invalidOptions.status).toBe(400);

  const enabled = await send(PUT, "PUT", "/bubbles/foo", { options: 3 });
  const [syncedRecord] = manager.sync.mock.lastCall ?? [];
  expect(enabled.status).toBe(202);
  expect(syncedRecord).toMatchObject({ bubbleName: "foo", options: 3 });

  const disabled = await send(PUT, "PUT", "/bubbles/foo", { options: 0 });
  expect(disabled.status).toBe(202);
  expect(manager.disable).toHaveBeenCalledWith("foo");

  const unknownHash = await send(PUT, "PUT", "/bubbles/foo", {
    hash: "nope",
    options: 3,
  });
  expect(unknownHash.status).toBe(404);
});

test("snapshot endpoints build, list and delete snapshots", async () => {
  await writeEntry("foo.bubble.ts");
  await writeEntry("broken.bubble.ts", "export default (;");

  const routes = createControlRoutes({
    manager,
    logger,
    sourceDir,
    snapshotDir,
  });
  const { GET, POST, DELETE } = routes["/snapshots/*"];

  const built = await send(POST, "POST", "/snapshots/foo");
  const { hash, createdAt } = built.body;
  expect(built.status).toBe(201);

  const noEntry = await send(POST, "POST", "/snapshots/none");
  expect(noEntry.status).toBe(404);

  const brokenBuild = await send(POST, "POST", "/snapshots/broken");
  expect(brokenBuild.status).toBe(422);

  const activeStats = running(hash);
  stats.set("foo", activeStats);
  const listed = await send(GET, "GET", "/snapshots/foo");
  expect(listed.body.snapshots).toEqual([{ hash, createdAt }]);

  const withoutHash = await send(DELETE, "DELETE", "/snapshots/foo");
  expect(withoutHash.status).toBe(400);

  const deleteUrl = `/snapshots/foo?hash=${hash}`;
  const deleteActive = await send(DELETE, "DELETE", deleteUrl);
  expect(deleteActive.status).toBe(409);

  stats.clear();
  const deleted = await send(DELETE, "DELETE", deleteUrl);
  expect(deleted.status).toBe(204);

  const deletedAgain = await send(DELETE, "DELETE", deleteUrl);
  expect(deletedAgain.status).toBe(404);
});

test("source endpoints list and inspect bubble entries", async () => {
  await writeEntry("foo.bubble.js");
  await writeEntry("foo.bubble.ts");
  await writeEntry("nested/bar.bubble.ts");

  const routes = createControlRoutes({
    manager,
    logger,
    sourceDir,
    snapshotDir,
  });
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
