import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CHECK_AT_ONCE_CHARS,
  CHECK_DELAY_MS,
  useYamlCheck,
} from "./useYamlCheck";
import * as validate from "./validate";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Valid YAML of more than `CHECK_AT_ONCE_CHARS` characters, ending in `tail`. */
function large(tail: string): string {
  const lines: string[] = [];
  for (let size = 0; size <= CHECK_AT_ONCE_CHARS; ) {
    const line = `  key-${lines.length}: value\n`;
    lines.push(line);
    size += line.length;
  }
  return `data:\n${lines.join("")}${tail}`;
}

test("text of an ordinary size is checked as it changes", () => {
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) => useYamlCheck(text),
    { initialProps: { text: "a: 1\n" } },
  );
  expect(result.current).toEqual({
    check: { ok: true, documents: 1 },
    pending: false,
  });

  rerender({ text: "a: [1\n" });
  expect(result.current.pending).toBe(false);
  expect(result.current.check.ok).toBe(false);
});

test("long text is parsed once, after the typing pauses", () => {
  const parse = vi.spyOn(validate, "validateYaml");
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) => useYamlCheck(text),
    { initialProps: { text: large("") } },
  );
  expect(result.current.pending).toBe(true);
  expect(parse).not.toHaveBeenCalled();

  // Three keys, each sooner than the delay after the one before.
  for (const tail of ["x", "x:", "x: 1\n"]) {
    act(() => {
      vi.advanceTimersByTime(CHECK_DELAY_MS - 50);
    });
    rerender({ text: large(tail) });
  }
  expect(parse).not.toHaveBeenCalled();
  expect(result.current.pending).toBe(true);

  act(() => {
    vi.advanceTimersByTime(CHECK_DELAY_MS);
  });
  expect(parse).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual({
    check: { ok: true, documents: 1 },
    pending: false,
  });
});

test("while long text waits for its check, the last problem stays and nothing may be sent", () => {
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) => useYamlCheck(text),
    { initialProps: { text: large("broken: [1\n") } },
  );
  act(() => {
    vi.advanceTimersByTime(CHECK_DELAY_MS);
  });
  expect(result.current.pending).toBe(false);
  expect(result.current.check.ok).toBe(false);

  rerender({ text: large("broken: [1]\n") });
  expect(result.current.pending).toBe(true);
  expect(result.current.check.ok).toBe(false);

  act(() => {
    vi.advanceTimersByTime(CHECK_DELAY_MS);
  });
  expect(result.current).toEqual({
    check: { ok: true, documents: 1 },
    pending: false,
  });
});

test("text that shrinks to an ordinary size is checked at once again", () => {
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) => useYamlCheck(text),
    { initialProps: { text: large("") } },
  );
  expect(result.current.pending).toBe(true);

  rerender({ text: "a: [1\n" });
  expect(result.current.pending).toBe(false);
  expect(result.current.check.ok).toBe(false);
});
