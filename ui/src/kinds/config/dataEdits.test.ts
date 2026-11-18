import { expect, test } from "vitest";
import {
  base64Bytes,
  base64ToText,
  dataChanges,
  dataOf,
  isValidDataKey,
  keyCount,
  rawHint,
  sameValue,
  textToBase64,
} from "./dataEdits";

test("only what changed is sent", () => {
  expect(
    dataChanges({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" }),
  ).toEqual([
    { key: "b", value: "9" },
    { key: "c", value: null },
    { key: "d", value: "4" },
  ]);
  expect(dataChanges({ a: "1" }, { a: "1" })).toEqual([]);
});

test("a comparison may count different text as the same value", () => {
  const same = (_key: string, a: string, b: string) => a.trim() === b.trim();
  expect(dataChanges({ a: "1", b: "2" }, { a: "1 ", b: "3" }, same)).toEqual([
    { key: "b", value: "3" },
  ]);
});

test("a data key is what the API allows", () => {
  for (const good of ["a", "a.b", "a-b_c", "A1"])
    expect(isValidDataKey(good)).toBe(true);
  for (const bad of ["", "a b", "a/b", "é", "x".repeat(254)])
    expect(isValidDataKey(bad)).toBe(false);
});

test("a key named like an object member is an ordinary key", () => {
  expect(
    dataChanges({}, { constructor: "x" } as Record<string, string>),
  ).toEqual([{ key: "constructor", value: "x" }]);
  expect(dataChanges({ toString: "x" } as Record<string, string>, {})).toEqual([
    { key: "toString", value: null },
  ]);
});

test("anything but a map of strings reads as no data", () => {
  expect(dataOf(undefined)).toEqual({});
  expect(dataOf("text")).toEqual({});
  expect(dataOf(["a"])).toEqual({});
  expect(dataOf({ a: "1", b: 2 })).toEqual({ a: "1" });
  expect(keyCount({ a: "1", b: "" })).toBe(2);
  expect(keyCount(null)).toBe(0);
});

test("text becomes the standard base64 of its UTF-8 bytes", () => {
  expect(textToBase64("héllo")).toBe("aMOpbGxv");
  expect(textToBase64("a")).toBe("YQ==");
  expect(textToBase64("")).toBe("");
});

test("base64 may hold whitespace and line breaks, and nothing else", () => {
  expect(base64Bytes(" aMOp\nbGxv\r\n\t")).toEqual(
    new Uint8Array([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]),
  );
  expect(base64Bytes("")).toEqual(new Uint8Array([]));
  for (const bad of ["abc!", "YQ", "YR==", "YQ==YQ==", "a\u00a0b=="])
    expect(base64Bytes(bad)).toBeNull();
});

test("base64 reads as text only when its bytes are UTF-8", () => {
  expect(base64ToText("aMOpbGxv")).toBe("héllo");
  expect(base64ToText("77u/YQ==")).toBe("\ufeffa");
  expect(base64ToText("/w==")).toBeNull();
  expect(base64ToText("abc!")).toBeNull();
});

test("raw can be chosen unless the base64 text is not base64 of UTF-8 text", () => {
  expect(rawHint("raw", "abc!")).toBeUndefined();
  expect(rawHint("base64", "YWJj")).toBeUndefined();
  expect(rawHint("base64", "abc!")).toBe("Not valid base64.");
  expect(rawHint("base64", "/w==")).toBe("Binary value: edit it as base64.");
});

test("base64 texts are the same value when they encode the same bytes", () => {
  expect(sameValue("base64", "YWJj", " YW\nJj\n")).toBe(true);
  expect(sameValue("base64", "YWJj", "YWJk")).toBe(false);
  expect(sameValue("base64", "abc!", "abc!")).toBe(true);
  expect(sameValue("raw", "YWJj", " YWJj")).toBe(false);
  expect(sameValue("raw", "x", "x")).toBe(true);
});
