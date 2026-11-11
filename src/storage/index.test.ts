import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BubbleOption, createStorage, type Storage } from "./index";

describe("createStorage", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage(":memory:");
  });

  afterEach(() => {
    storage.close();
  });

  describe("createBubble", () => {
    test("applies defaults for omitted fields", () => {
      expect(storage.createBubble({ sourcePath: "a.ts" })).toEqual({
        sourcePath: "a.ts",
        sourceHash: "",
        name: "",
        options: 0,
      });
    });

    test("stores provided fields", () => {
      const record = {
        sourcePath: "a.ts",
        sourceHash: "abc123",
        name: "alpha",
        options: BubbleOption.Enabled | BubbleOption.Routing,
      };

      expect(storage.createBubble(record)).toEqual(record);
      expect(storage.getBubble("a.ts")).toEqual(record);
    });

    test("throws on duplicate sourcePath", () => {
      storage.createBubble({ sourcePath: "a.ts" });

      expect(() => storage.createBubble({ sourcePath: "a.ts" })).toThrow();
    });
  });

  describe("getBubble", () => {
    test("returns null for missing sourcePath", () => {
      expect(storage.getBubble("missing.ts")).toBeNull();
    });
  });

  describe("listBubbles", () => {
    test("returns empty array when no bubbles exist", () => {
      expect(storage.listBubbles()).toEqual([]);
    });

    test("returns bubbles ordered by sourcePath", () => {
      storage.createBubble({ sourcePath: "c.ts" });
      storage.createBubble({ sourcePath: "a.ts" });
      storage.createBubble({ sourcePath: "b/index.ts" });

      expect(storage.listBubbles().map((b) => b.sourcePath)).toEqual([
        "a.ts",
        "b/index.ts",
        "c.ts",
      ]);
    });
  });

  describe("updateBubble", () => {
    beforeEach(() => {
      storage.createBubble({
        sourcePath: "a.ts",
        sourceHash: "abc123",
        name: "alpha",
        options: BubbleOption.Enabled,
      });
    });

    test("updates only provided fields", () => {
      expect(storage.updateBubble("a.ts", { name: "beta" })).toEqual({
        sourcePath: "a.ts",
        sourceHash: "abc123",
        name: "beta",
        options: BubbleOption.Enabled,
      });

      expect(
        storage.updateBubble("a.ts", { options: BubbleOption.Routing }),
      ).toEqual({
        sourcePath: "a.ts",
        sourceHash: "abc123",
        name: "beta",
        options: BubbleOption.Routing,
      });

      expect(storage.updateBubble("a.ts", { sourceHash: "def456" })).toEqual({
        sourcePath: "a.ts",
        sourceHash: "def456",
        name: "beta",
        options: BubbleOption.Routing,
      });
    });

    test("treats empty string and zero as values rather than omissions", () => {
      expect(
        storage.updateBubble("a.ts", { sourceHash: "", name: "", options: 0 }),
      ).toEqual({
        sourcePath: "a.ts",
        sourceHash: "",
        name: "",
        options: 0,
      });
    });

    test("leaves record unchanged when input is empty", () => {
      expect(storage.updateBubble("a.ts", {})).toEqual({
        sourcePath: "a.ts",
        sourceHash: "abc123",
        name: "alpha",
        options: BubbleOption.Enabled,
      });
    });

    test("returns null for missing sourcePath", () => {
      expect(storage.updateBubble("missing.ts", { name: "x" })).toBeNull();
      expect(storage.getBubble("missing.ts")).toBeNull();
    });
  });

  describe("deleteBubble", () => {
    test("removes existing bubble and returns true", () => {
      storage.createBubble({ sourcePath: "a.ts" });

      expect(storage.deleteBubble("a.ts")).toBe(true);
      expect(storage.getBubble("a.ts")).toBeNull();
    });

    test("returns false for missing sourcePath", () => {
      expect(storage.deleteBubble("missing.ts")).toBe(false);
    });
  });
});

describe("createStorage with file database", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "nibble-storage-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("persists records across reopen", () => {
    const databasePath = path.join(tempDir, "bubbles.db");

    const first = createStorage(databasePath);
    first.createBubble({ sourcePath: "a.ts", name: "alpha" });
    first.close();

    const second = createStorage(databasePath);
    try {
      expect(second.getBubble("a.ts")).toEqual({
        sourcePath: "a.ts",
        sourceHash: "",
        name: "alpha",
        options: 0,
      });
    } finally {
      second.close();
    }
  });
});
