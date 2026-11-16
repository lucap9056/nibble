import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSnapshot } from "./resolver";

const ROOT_DIR_PREFIX = path.join(os.tmpdir(), "nibble-resolver-");

let rootDir: string;
let sourceDir: string;
let snapshotDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(ROOT_DIR_PREFIX);
  sourceDir = path.join(rootDir, "bubbles");
  snapshotDir = path.join(rootDir, "snapshots");
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const writeEntry = (file: string, content: string) => {
  const entryPath = path.join(sourceDir, file);
  return Bun.write(entryPath, content);
};

test("builds the highest-precedence entry for a shared bubble name", async () => {
  await writeEntry("foo/bar.bubble.js", "export default 'js';");
  await writeEntry("foo/bar.bubble.ts", "export default 'ts';");
  await writeEntry("foo/bar.helper.mts", "");

  const snapshot = await resolveSnapshot(sourceDir, "foo/bar", snapshotDir);
  const expectedDir = path.join(snapshotDir, "foo", "bar");
  const { default: builtFrom } = await import(snapshot.snapshotPath);

  expect(snapshot.bubbleName).toBe("foo/bar");
  expect(snapshot.snapshotPath).toStartWith(expectedDir);
  expect(builtFrom).toBe("ts");
});

test("resolves a snapshot by hash regardless of the current entry", async () => {
  await writeEntry("foo.bubble.js", "export default 'js';");
  const built = await resolveSnapshot(sourceDir, "foo", snapshotDir);

  await writeEntry("foo.bubble.ts", "export default 1;");
  const { snapshotHash } = built;
  const resolved = await resolveSnapshot(
    sourceDir,
    "foo",
    snapshotDir,
    snapshotHash,
  );
  expect(resolved.snapshotPath).toBe(built.snapshotPath);
});

test("rejects a bubble name without any entry", async () => {
  await writeEntry("foo.helper.ts", "");
  const resolved = resolveSnapshot(sourceDir, "foo", snapshotDir);
  await expect(resolved).rejects.toThrow("Bubble entry not found: foo");
});
