import { BinaryWriter, sizeDelimitedPeek } from "@bufbuild/protobuf/wire";

export const encodeDelimited = (body: Uint8Array): Uint8Array =>
  new BinaryWriter().bytes(body).finish();

const concat = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  if (head.length === 0) return tail;
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head);
  merged.set(tail, head.length);
  return merged;
};

export async function* decodeDelimited(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let buffer: Uint8Array = new Uint8Array(0);
  for await (const chunk of stream) {
    buffer = concat(buffer, chunk);
    for (;;) {
      const { eof, size, offset } = sizeDelimitedPeek(buffer);
      if (eof || offset + size > buffer.length) break;
      yield buffer.subarray(offset, offset + size);
      buffer = buffer.subarray(offset + size);
    }
  }
}
