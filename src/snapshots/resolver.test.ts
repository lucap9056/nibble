import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSnapshot } from "./resolver";

let rootDir: string;
let sourceDir: string;
let snapshotDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "nibble-resolver-"));
  sourceDir = path.join(rootDir, "bubbles");
  snapshotDir = path.join(rootDir, "snapshots");
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const readSnapshot = async (snapshotPath: string) =>
  import(snapshotPath).then((module) => module.default);

test("builds the highest-precedence entry for a shared bubble name", async () => {
  const entryDir = path.join(sourceDir, "foo");
  await Bun.write(path.join(entryDir, "bar.bubble.js"), "export default 'js';");
  await Bun.write(path.join(entryDir, "bar.bubble.ts"), "export default 'ts';");
  await Bun.write(path.join(entryDir, "bar.helper.mts"), "");

  const snapshot = await resolveSnapshot(sourceDir, "foo/bar", snapshotDir);
  expect(snapshot.bubbleName).toBe("foo/bar");
  expect(path.dirname(snapshot.snapshotPath)).toBe(
    path.join(snapshotDir, "foo", "bar"),
  );
  expect(await readSnapshot(snapshot.snapshotPath)).toBe("ts");
});

test("resolves a snapshot by hash regardless of the current entry", async () => {
  const jsEntry = path.join(sourceDir, "foo.bubble.js");
  await Bun.write(jsEntry, "export default 'js';");
  const built = await resolveSnapshot(sourceDir, "foo", snapshotDir);

  await Bun.write(path.join(sourceDir, "foo.bubble.ts"), "export default 1;");
  const resolved = await resolveSnapshot(
    sourceDir,
    "foo",
    snapshotDir,
    built.snapshotHash,
  );
  expect(resolved.snapshotPath).toBe(built.snapshotPath);
});

test("rejects a bubble name without any entry", async () => {
  await Bun.write(path.join(sourceDir, "foo.helper.ts"), "");
  const resolved = resolveSnapshot(sourceDir, "foo", snapshotDir);
  await expect(resolved).rejects.toThrow("Bubble entry not found: foo");
});
