import { describe, expect, test } from "bun:test";
import { decodeDelimited, encodeDelimited } from "./delimited";

const collect = async (chunks: Uint8Array[]) => {
  async function* stream() {
    yield* chunks;
  }
  const frames: number[][] = [];
  for await (const frame of decodeDelimited(stream())) {
    frames.push([...frame]);
  }
  return frames;
};

const join = (parts: Uint8Array[]) => {
  const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

describe("decodeDelimited", () => {
  const small = new Uint8Array([1, 2, 3]);
  const large = new Uint8Array(300).fill(7);
  const empty = new Uint8Array(0);
  const wire = join([small, large, empty].map(encodeDelimited));
  const expected = [[...small], [...large], []];

  test("decodes several frames from one chunk", async () => {
    expect(await collect([wire])).toEqual(expected);
  });

  test("reassembles frames split at every byte, including the varint", async () => {
    const bytes = [...wire].map((byte) => new Uint8Array([byte]));
    expect(await collect(bytes)).toEqual(expected);
  });

  test("drops a trailing incomplete frame", async () => {
    expect(await collect([wire.subarray(0, wire.length - 3)])).toEqual([
      [...small],
    ]);
  });
});
