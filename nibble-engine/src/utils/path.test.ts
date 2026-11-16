import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listBubbleEntries } from "./path";

const SOURCE_DIR_PREFIX = path.join(os.tmpdir(), "nibble-path-");

let sourceDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(SOURCE_DIR_PREFIX);
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
});

test("lists one entry per bubble name by extension precedence", async () => {
  const files = [
    "index.bubble.js",
    "foo.bubble.js",
    "foo.bubble.ts",
    "foo/index.bubble.cjs",
    "foo/bar.bubble.mts",
    "foo/bar.helper.ts",
    "foo/bad name.bubble.ts",
    "node_modules/pkg/dep.bubble.ts",
  ];
  const writes = files.map((file) => {
    const filePath = path.join(sourceDir, file);
    return Bun.write(filePath, "");
  });
  await Promise.all(writes);

  const entries = await listBubbleEntries(sourceDir);
  const relativeEntries = entries.map(({ bubbleName, entryPath }) => {
    const relativePath = path.relative(sourceDir, entryPath);
    return [bubbleName, relativePath.split(path.sep).join("/")];
  });
  expect(relativeEntries).toEqual([
    ["foo", "foo.bubble.ts"],
    ["foo/bar", "foo/bar.bubble.mts"],
    ["foo/index", "foo/index.bubble.cjs"],
    ["index", "index.bubble.js"],
  ]);
});

test("returns an empty list for a directory without bubbles", async () => {
  const entries = await listBubbleEntries(sourceDir);
  expect(entries).toEqual([]);
});
