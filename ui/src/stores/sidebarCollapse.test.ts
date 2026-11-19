import { mockWindows } from "@tauri-apps/api/mocks";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { flush, mockBackend } from "../test/ipc";
import {
  resetSidebarToggleForTest,
  sidebarCollapsedKey,
  toggleSidebar,
  useSidebarCollapse,
  useSidebarToggle,
} from "./sidebarCollapse";

beforeEach(() => {
  resetSidebarToggleForTest();
});

test("the state's key names the window (spec Q §3)", () => {
  expect(sidebarCollapsedKey("main")).toBe("sidebar.collapsed.main");
  expect(sidebarCollapsedKey()).toBe("sidebar.collapsed.main");
  mockWindows("window-3");
  expect(sidebarCollapsedKey()).toBe("sidebar.collapsed.window-3");
});

test("the mounted hook lends its toggle, reads a saved non-boolean as expanded, and takes the toggle back when it unmounts", async () => {
  const backend = mockBackend({
    ui_state_get: () => "yes",
    ui_state_set: () => null,
  });
  expect(toggleSidebar()).toBe(false);
  const { result, unmount } = renderHook(() => useSidebarCollapse());
  await act(flush);
  expect(result.current[0]).toBe(false);
  expect(backend.callsTo("ui_state_get")).toEqual([
    { key: "sidebar.collapsed.main" },
  ]);
  act(() => {
    expect(toggleSidebar()).toBe(true);
  });
  expect(result.current[0]).toBe(true);
  expect(useSidebarToggle.getState().collapsed).toBe(true);
  act(() => result.current[1]());
  expect(result.current[0]).toBe(false);
  expect(useSidebarToggle.getState().collapsed).toBe(false);
  unmount();
  expect(useSidebarToggle.getState().toggle).toBeNull();
  expect(toggleSidebar()).toBe(false);
});
