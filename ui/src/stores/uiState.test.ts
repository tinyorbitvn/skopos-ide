import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { flush, mockBackend } from "../test/ipc";
import { flushUiStateWrites, useColumnWidths, useUiState } from "./uiState";

test("loads the saved value and saves changes after a pause", async () => {
  const backend = mockBackend({
    ui_state_get: () => ({ w: 1 }),
    ui_state_set: () => null,
  });
  const { result } = renderHook(() => useUiState("k", { w: 0 }));
  await act(flush);
  expect(result.current[0]).toEqual({ w: 1 });

  vi.useFakeTimers();
  act(() => result.current[1]({ w: 2 }));
  act(() => result.current[1]({ w: 3 }));
  expect(backend.callsTo("ui_state_set")).toEqual([]);
  act(() => {
    vi.advanceTimersByTime(300);
  });
  vi.useRealTimers();
  expect(backend.callsTo("ui_state_set")).toEqual([
    { key: "k", value: { w: 3 } },
  ]);
});

test("keeps the initial value when nothing is saved", async () => {
  mockBackend({ ui_state_get: () => null });
  const { result } = renderHook(() => useUiState("k", 5));
  await act(flush);
  expect(result.current[0]).toBe(5);
});

test("saves a pending change on unmount", async () => {
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
  });
  const { result, unmount } = renderHook(() => useUiState("k", "a"));
  await act(flush);
  act(() => result.current[1]("b"));
  unmount();
  expect(backend.callsTo("ui_state_set")).toEqual([{ key: "k", value: "b" }]);
});

test("reports loaded once the saved value was read, also when the read fails", async () => {
  let answer: (value: unknown) => void = () => {};
  mockBackend({
    ui_state_get: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  const { result } = renderHook(() => useUiState("k", 5));
  expect(result.current[2]).toBe(false);
  await act(async () => {
    answer(7);
    await flush();
  });
  expect(result.current).toEqual([7, expect.any(Function), true]);

  mockBackend({
    ui_state_get: () => {
      throw new Error("no state");
    },
  });
  const failed = renderHook(() => useUiState("other", 5));
  await act(flush);
  expect(failed.result.current[2]).toBe(true);
});

test("a reader mounted while a write is unsaved shows that write, though its read overtakes it", async () => {
  // The backend may answer a read sent after a write before it saves that write: a
  // screen that unmounts flushes its change, and the next screen reads the same key.
  let stored: unknown = "a";
  let save: () => void = () => {};
  const backend = mockBackend({
    ui_state_get: () => stored,
    ui_state_set: (args) =>
      new Promise((resolve) => {
        save = () => {
          stored = (args as { value: unknown }).value;
          resolve(null);
        };
      }),
  });
  const first = renderHook(() => useUiState("race", "a"));
  await act(flush);
  act(() => first.result.current[1]("b"));
  first.unmount();
  expect(backend.callsTo("ui_state_set")).toEqual([
    { key: "race", value: "b" },
  ]);

  const second = renderHook(() => useUiState("race", "a"));
  await act(flush);
  expect(second.result.current[0]).toBe("b");

  // Once saved, a new reader asks the backend again, which another window may have
  // changed since.
  await act(async () => {
    save();
    await flush();
  });
  stored = "c";
  const third = renderHook(() => useUiState("race", "a"));
  await act(flush);
  expect(third.result.current[0]).toBe("c");
});

test("flushUiStateWrites saves pending writes at once and waits for the backend", async () => {
  let save: () => void = () => {};
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () =>
      new Promise((resolve) => {
        save = () => resolve(null);
      }),
  });
  const { result } = renderHook(() => useUiState("flushed", "a"));
  await act(flush);
  act(() => result.current[1]("b"));

  let done = false;
  const flushed = flushUiStateWrites().then(() => {
    done = true;
  });
  expect(backend.callsTo("ui_state_set")).toEqual([
    { key: "flushed", value: "b" },
  ]);
  await flush();
  expect(done).toBe(false);
  save();
  await flushed;
  expect(done).toBe(true);
});

test("flushUiStateWrites with nothing pending resolves without a call", async () => {
  const backend = mockBackend({ ui_state_get: () => null });
  renderHook(() => useUiState("idle", "a"));
  await act(flush);
  await flushUiStateWrites();
  expect(backend.callsTo("ui_state_set")).toEqual([]);
});

test("a value this window is still saving under another key is not taken", async () => {
  let saved: unknown = ["a"];
  let finish: () => void = () => {};
  mockBackend({
    ui_state_get: () => saved,
    ui_state_set: (args) =>
      new Promise((resolve) => {
        finish = () => {
          saved = (args as { value: unknown }).value;
          resolve(null);
        };
      }),
  });
  const first = renderHook(() => useUiState<string[]>("saving", []));
  await act(flush);
  act(() => first.result.current[1](["b"]));
  first.unmount();

  const other = renderHook(() => useUiState<string[]>("another", []));
  await act(flush);
  expect(other.result.current[0]).toEqual(["a"]);
  await act(async () => {
    finish();
    await flush();
  });
});

test("a table's column widths are kept under its name, ready for the table's props", async () => {
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) =>
      a.key === "column-widths:#helm-releases" ? { name: 200 } : null,
    ui_state_set: () => null,
  });
  const { result, unmount } = renderHook(() =>
    useColumnWidths("#helm-releases"),
  );
  expect(result.current.columnWidths).toEqual({});
  await act(flush);
  expect(result.current.columnWidths).toEqual({ name: 200 });
  act(() => result.current.onColumnWidthsChange({ name: 240 }));
  expect(result.current.columnWidths).toEqual({ name: 240 });
  unmount();
  expect(backend.callsTo("ui_state_set")).toEqual([
    { key: "column-widths:#helm-releases", value: { name: 240 } },
  ]);
});
