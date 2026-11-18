import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  resetWindowLayoutForTest,
  startWindowLayout,
  useWindowLayout,
} from "../../stores/windowLayout";
import { clusterEntry, mockBackend } from "../../test/ipc";
import {
  moveTabToWindow,
  newWindowPoint,
  openInNewWindow,
  refreshWindowList,
  resetWindowListForTest,
  useWindowList,
  windowChoices,
  windowName,
} from "./windowMoves";

function tab(id: string, path: string): TabState {
  return { id, pinned: false, history: [path], index: 0 };
}

function windowOf(label: string, tabs: TabState[]): WindowLayout {
  return {
    label,
    bounds: { x: 100, y: 50, width: 800, height: 600, maximized: false },
    panes: [{ id: `p-${label}`, width: 1, selected: tabs[0]?.id ?? "", tabs }],
    focusedPane: 0,
  };
}

const MAIN = windowOf("main", [
  tab("t1", "/catalog"),
  tab("t2", "/preferences"),
]);
const SECOND = windowOf("window-2", [tab("t3", "/cluster/c1/map")]);

beforeEach(() => {
  resetWindowLayoutForTest(MAIN);
  resetWindowListForTest();
});

afterEach(() => {
  resetWindowLayoutForTest();
  vi.restoreAllMocks();
});

test("windows are named Main window and Window ‹n›", () => {
  expect(windowName("main")).toBe("Main window");
  expect(windowName("window-3")).toBe("Window 3");
  expect(windowName("other")).toBe("other");
});

test("the other windows, with the title of each one's focused tab (P15)", () => {
  const empty = windowOf("window-3", []);
  const clusters = [clusterEntry({ id: "c1", name: "prod" })];
  expect(windowChoices([MAIN, SECOND, empty], "window-2", clusters)).toEqual([
    { label: "main", name: "Main window", title: "Catalog" },
    { label: "window-3", name: "Window 3", title: "No tabs" },
  ]);
  expect(windowChoices([MAIN, SECOND], "main", clusters)).toEqual([
    { label: "window-2", name: "Window 2", title: "Resource map · prod" },
  ]);
});

test("a new window opens a step below and right of this one, in physical pixels", () => {
  const bounds = { x: 100, y: 50, width: 800, height: 600, maximized: false };
  expect(newWindowPoint(bounds, 2, { x: 0, y: 0 })).toEqual({ x: 164, y: 114 });
  // Without saved bounds: the window's screen position, in logical pixels.
  expect(newWindowPoint(null, 1.5, { x: 10, y: 20 })).toEqual({
    x: 63,
    y: 78,
  });
});

test("the list of windows comes from the core", async () => {
  mockBackend({ windows_list: () => [MAIN, SECOND] });
  await refreshWindowList();
  expect(useWindowList.getState().layouts).toEqual([MAIN, SECOND]);
});

test("a move to another window sends the pending save first and changes nothing here (P33)", async () => {
  const backend = mockBackend({
    window_layout_get: () => MAIN,
    window_layout_set: () => null,
    window_tab_move: () => ({
      target: "window-2",
      created: false,
      sourceEmpty: false,
    }),
  });
  resetWindowLayoutForTest();
  await startWindowLayout(() => true);
  useWindowLayout.getState().dispatch({ type: "select", tabId: "t2" });
  const before = useWindowLayout.getState().layout;

  await moveTabToWindow("t2", "window-2");

  expect(backend.callsTo("window_tab_move")).toEqual([
    { tabId: "t2", target: { kind: "window", label: "window-2" } },
  ]);
  const order = backend.calls
    .map((c) => c.cmd)
    .filter((cmd) => cmd === "window_layout_set" || cmd === "window_tab_move");
  expect(order).toEqual(["window_layout_set", "window_tab_move"]);
  // The core's layout event moves the tab.
  expect(useWindowLayout.getState().layout).toBe(before);
});

test("a move to a window that closed meanwhile says so (P44)", async () => {
  mockBackend({
    window_tab_move: () => {
      throw { code: "NotFound", message: "That window is closed." };
    },
  });
  const failed = vi.spyOn(toast, "error");

  await moveTabToWindow("t2", "window-2");

  expect(failed).toHaveBeenCalledWith("That window is closed.");
});

test("Open in new window places it beside this one, and a failure says why (P31, P44)", async () => {
  let fail = false;
  const backend = mockBackend({
    windows_list: () => [MAIN, SECOND],
    window_tab_move: () => {
      if (fail) {
        throw {
          code: "Internal",
          message: "Could not open a new window: no display.",
        };
      }
      return { target: "window-3", created: true, sourceEmpty: false };
    },
  });
  const failed = vi.spyOn(toast, "error");
  const scale = window.devicePixelRatio;

  await openInNewWindow("t2");

  const step = Math.round(32 * scale);
  expect(backend.callsTo("window_tab_move")).toEqual([
    {
      tabId: "t2",
      target: { kind: "newWindow", x: 100 + step, y: 50 + step },
    },
  ]);

  fail = true;
  await openInNewWindow("t2");
  await waitFor(() =>
    expect(failed).toHaveBeenCalledWith(
      "Could not open a new window: no display.",
    ),
  );
});
