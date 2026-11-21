import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { flush, mockBackend } from "../test/ipc";
import { resetUiStateForTest, useUiState } from "./uiState";

afterEach(resetUiStateForTest);

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

/**
 * A backend that, like the real one, answers a read with the value from before until
 * a write is done. `finish` ends the writes under way.
 */
function slowToSave(first: unknown) {
  let saved = first;
  let waiting: (() => void)[] = [];
  const backend = mockBackend({
    ui_state_get: () => saved,
    ui_state_set: (a: { value: unknown }) =>
      new Promise((resolve) => {
        waiting.push(() => {
          saved = a.value;
          resolve(null);
        });
      }),
  });
  return {
    backend,
    finish: async () => {
      const done = waiting;
      waiting = [];
      await act(async () => {
        for (const end of done) end();
        await flush();
      });
    },
  };
}

test("the next reader of a key gets the value this window is still saving", async () => {
  const { finish } = slowToSave(["a"]);
  const first = renderHook(() => useUiState<string[]>("k", []));
  await act(flush);
  act(() => first.result.current[1](["b"]));
  first.unmount();

  const second = renderHook(() => useUiState<string[]>("k", []));
  await act(flush);
  expect(second.result.current).toEqual([["b"], expect.any(Function), true]);

  await finish();
  expect(second.result.current[0]).toEqual(["b"]);
  const third = renderHook(() => useUiState<string[]>("k", []));
  await act(flush);
  expect(third.result.current[0]).toEqual(["b"]);
});

test("a value saved while a read is under way wins over what the read answers", async () => {
  const reads: ((value: unknown) => void)[] = [];
  mockBackend({
    ui_state_get: () => new Promise((resolve) => reads.push(resolve)),
    ui_state_set: () => null,
  });
  const reader = renderHook(() => useUiState<string[]>("k", []));
  const writer = renderHook(() => useUiState<string[]>("k", []));
  act(() => writer.result.current[1](["b"]));
  writer.unmount();
  await act(flush);

  await act(async () => {
    for (const answer of reads) answer(["a"]);
    await flush();
  });
  expect(reader.result.current).toEqual([["b"], expect.any(Function), true]);
});

test("a saved value of another key is not taken", async () => {
  const { finish } = slowToSave(["a"]);
  const first = renderHook(() => useUiState<string[]>("k", []));
  await act(flush);
  act(() => first.result.current[1](["b"]));
  first.unmount();

  const other = renderHook(() => useUiState<string[]>("other", []));
  await act(flush);
  expect(other.result.current[0]).toEqual(["a"]);
  await finish();
});
