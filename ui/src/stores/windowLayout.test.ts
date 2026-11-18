import { mockWindows } from "@tauri-apps/api/mocks";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { focusedTab, tabPath } from "../app/tabs/layout";
import type { TabState } from "../ipc/generated/TabState";
import type { WindowLayout } from "../ipc/generated/WindowLayout";
import { emitEvent, flush, mockBackend } from "../test/ipc";
import {
  flushWindowLayout,
  LAYOUT_SAVE_DELAY_MS,
  resetWindowLayoutForTest,
  startLayout,
  startWindowLayout,
  useWindowLayout,
} from "./windowLayout";

const isRoute = (path: string) => !path.startsWith("/workspace");

function layoutOf(label: string, tabs: TabState[]): WindowLayout {
  return {
    label,
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: tabs[0]?.id ?? "", tabs }],
    focusedPane: 0,
  };
}

function tab(id: string, path: string): TabState {
  return { id, pinned: false, history: [path], index: 0 };
}

function openTab(path: string): void {
  useWindowLayout.getState().dispatch({
    type: "open",
    path,
    mode: "newTab",
    newTabId: path,
    newPaneId: "x",
  });
}

beforeEach(() => resetWindowLayoutForTest());
afterEach(() => {
  vi.useRealTimers();
  resetWindowLayoutForTest();
});

test("a window starts with one Catalog tab in one pane", () => {
  const layout = startLayout("window-2");
  expect(layout.label).toBe("window-2");
  expect(layout.panes).toHaveLength(1);
  const first = focusedTab(layout);
  expect(first && tabPath(first)).toBe("/catalog");
  expect(layout.panes[0].selected).toBe(first?.id);
  expect(layout.panes[0].width).toBe(1);
});

test("dispatch applies the reducer and keeps the state when nothing changes", () => {
  const before = useWindowLayout.getState().layout;
  useWindowLayout.getState().dispatch({ type: "back" });
  expect(useWindowLayout.getState().layout).toBe(before);

  useWindowLayout.getState().dispatch({
    type: "open",
    path: "/preferences",
    mode: "current",
    newTabId: "n",
    newPaneId: "p",
  });
  const shown = focusedTab(useWindowLayout.getState().layout);
  expect(shown?.history).toEqual(["/catalog", "/preferences"]);
});

test("loads this window's layout from the core (P38)", async () => {
  const saved = layoutOf("main", [tab("t1", "/preferences")]);
  const backend = mockBackend({ window_layout_get: () => saved });
  await startWindowLayout(isRoute);
  expect(useWindowLayout.getState()).toMatchObject({
    label: "main",
    layout: saved,
    ready: true,
  });
  expect(backend.callsTo("window_layout_set")).toEqual([]);
});

test("drops tabs whose path matches no route and sends the result back (P39)", async () => {
  const backend = mockBackend({
    window_layout_get: () =>
      layoutOf("main", [tab("t1", "/workspace"), tab("t2", "/catalog")]),
    window_layout_set: () => null,
  });
  await startWindowLayout(isRoute);
  const { layout } = useWindowLayout.getState();
  expect(layout.panes[0].tabs.map((t) => t.id)).toEqual(["t2"]);
  expect(backend.callsTo("window_layout_set")).toEqual([{ layout }]);
});

test("a window that the core cannot answer for starts with a Catalog tab", async () => {
  mockBackend({});
  await startWindowLayout(isRoute);
  const shown = focusedTab(useWindowLayout.getState().layout);
  expect(shown && tabPath(shown)).toBe("/catalog");
  expect(useWindowLayout.getState().ready).toBe(true);
});

test("uses this window's label", async () => {
  mockWindows("window-2");
  mockBackend({
    window_layout_get: () => layoutOf("window-2", [tab("t1", "/catalog")]),
  });
  await startWindowLayout(isRoute);
  expect(useWindowLayout.getState().label).toBe("window-2");
});

test("saves 300 ms after the last change, once", async () => {
  const backend = mockBackend({
    window_layout_get: () => layoutOf("main", [tab("t1", "/catalog")]),
    window_layout_set: () => null,
  });
  await startWindowLayout(isRoute);
  vi.useFakeTimers();
  openTab("/a");
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS - 1);
  openTab("/b");
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS - 1);
  expect(backend.callsTo("window_layout_set")).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(backend.callsTo("window_layout_set")).toEqual([
    { layout: useWindowLayout.getState().layout },
  ]);
});

test("a pending save goes at once on pagehide, and a flush with nothing pending sends nothing", async () => {
  const backend = mockBackend({
    window_layout_get: () => layoutOf("main", [tab("t1", "/catalog")]),
    window_layout_set: () => null,
  });
  await startWindowLayout(isRoute);
  openTab("/a");
  window.dispatchEvent(new Event("pagehide"));
  expect(backend.callsTo("window_layout_set")).toHaveLength(1);
  await flushWindowLayout();
  expect(backend.callsTo("window_layout_set")).toHaveLength(1);
});

test("a layout from the core replaces this one and cancels the pending save", async () => {
  const backend = mockBackend({
    window_layout_get: () => layoutOf("main", [tab("t1", "/catalog")]),
    window_layout_set: () => null,
  });
  await startWindowLayout(isRoute);
  vi.useFakeTimers();
  openTab("/a");
  const moved = layoutOf("main", [
    tab("t1", "/catalog"),
    tab("t9", "/preferences"),
  ]);
  vi.useRealTimers();
  await emitEvent("window://layout", moved);
  expect(useWindowLayout.getState().layout).toEqual(moved);
  await act(async () => {
    await new Promise((r) => setTimeout(r, LAYOUT_SAVE_DELAY_MS + 50));
  });
  expect(backend.callsTo("window_layout_set")).toEqual([]);
});

test("another window's layout is not taken", async () => {
  mockBackend({
    window_layout_get: () => layoutOf("main", [tab("t1", "/catalog")]),
  });
  await startWindowLayout(isRoute);
  const before = useWindowLayout.getState().layout;
  await emitEvent(
    "window://layout",
    layoutOf("window-2", [tab("t5", "/catalog")]),
  );
  expect(useWindowLayout.getState().layout).toBe(before);
});

test("a window other than main saves at once when its last tab leaves (P21)", async () => {
  mockWindows("window-2");
  const backend = mockBackend({
    window_layout_get: () => layoutOf("window-2", [tab("t1", "/catalog")]),
    window_layout_set: () => null,
  });
  await startWindowLayout(isRoute);
  useWindowLayout.getState().dispatch({ type: "close", tabId: "t1" });
  await flush();
  expect(backend.callsTo("window_layout_set")).toHaveLength(1);
  expect(useWindowLayout.getState().layout.panes[0].tabs).toEqual([]);
});

test("main keeps its empty layout and saves it after the delay", async () => {
  const backend = mockBackend({
    window_layout_get: () => layoutOf("main", [tab("t1", "/catalog")]),
    window_layout_set: () => null,
  });
  await startWindowLayout(isRoute);
  vi.useFakeTimers();
  useWindowLayout.getState().dispatch({ type: "close", tabId: "t1" });
  expect(backend.callsTo("window_layout_set")).toEqual([]);
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS);
  expect(backend.callsTo("window_layout_set")).toHaveLength(1);
});

test("a layout sent while the core's answer is on its way wins over that answer (P33, P38)", async () => {
  let answer: (layout: WindowLayout) => void = () => {};
  const backend = mockBackend({
    window_layout_get: () =>
      new Promise<WindowLayout>((resolve) => {
        answer = resolve;
      }),
    window_layout_set: () => null,
  });
  const starting = startWindowLayout(isRoute);
  await vi.waitFor(() =>
    expect(backend.callsTo("window_layout_get")).toHaveLength(1),
  );
  const moved = layoutOf("main", [
    tab("t1", "/catalog"),
    tab("t9", "/preferences"),
  ]);

  await emitEvent("window://layout", moved);
  answer(layoutOf("main", [tab("t1", "/catalog")]));
  await starting;

  expect(useWindowLayout.getState()).toMatchObject({
    layout: moved,
    ready: true,
  });
  // Later layouts from the core still replace it, and none is saved back.
  const later = layoutOf("main", [tab("t9", "/preferences")]);
  await emitEvent("window://layout", later);
  expect(useWindowLayout.getState().layout).toEqual(later);
  expect(backend.callsTo("window_layout_set")).toEqual([]);
});

test("before the app quits, a flush sends the pending save at once and then answers (P34)", async () => {
  const backend = mockBackend({
    window_layout_get: () => layoutOf("main", [tab("t1", "/catalog")]),
    window_layout_set: () => null,
    window_flushed: () => null,
  });
  await startWindowLayout(isRoute);
  openTab("/a");

  await emitEvent("window://flush");

  expect(
    backend.calls
      .map((c) => c.cmd)
      .filter((cmd) => cmd !== "plugin:event|listen"),
  ).toEqual(["window_layout_get", "window_layout_set", "window_flushed"]);
  expect(backend.callsTo("window_layout_set")).toEqual([
    { layout: useWindowLayout.getState().layout },
  ]);
  // Nothing waits any more: the save timer was cancelled, and a flush with nothing
  // pending only answers.
  await emitEvent("window://flush");
  await act(async () => {
    await new Promise((r) => setTimeout(r, LAYOUT_SAVE_DELAY_MS + 50));
  });
  expect(backend.callsTo("window_layout_set")).toHaveLength(1);
  expect(backend.callsTo("window_flushed")).toHaveLength(2);
});
