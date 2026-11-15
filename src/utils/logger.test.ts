import { expect, test } from "bun:test";
import { serializeError } from "./logger";

test("serializes a plain error with name, message and stack", () => {
  const err = new TypeError("bad input");
  expect(serializeError(err)).toEqual({
    name: "TypeError",
    message: "bad input",
    stack: err.stack,
  });
});

test("follows the cause chain", () => {
  const root = new Error("disk full");
  const err = new Error("write failed", { cause: root });
  expect(serializeError(err)).toMatchObject({
    message: "write failed",
    cause: { name: "Error", message: "disk full" },
  });
});

test("expands AggregateError members", () => {
  const first = new Error("first");
  const second = new RangeError("second");
  const err = new AggregateError([first, second], "many failed");
  expect(serializeError(err)).toMatchObject({
    name: "AggregateError",
    message: "many failed",
    errors: [
      { name: "Error", message: "first" },
      { name: "RangeError", message: "second" },
    ],
  });
});

test("passes through non-error values", () => {
  const thrown = { code: 42 };
  expect(serializeError("boom")).toBe("boom");
  expect(serializeError(thrown)).toBe(thrown);
  expect(serializeError(undefined)).toBeUndefined();
});

test("keeps non-error causes as-is", () => {
  const cause = { status: 503 };
  const err = new Error("upstream failed", { cause });
  expect(serializeError(err)).toMatchObject({ cause });
});
