import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { DrawerTarget } from "../../kinds/detail/links";
import { DEPLOYMENTS } from "../../kinds/refs";
import {
  type DetailsDockTab,
  detailsTab,
  readDraft,
  resetDockForTest,
  useDock,
} from "../../stores/dock";
import { shownDetailsEntry, useDetailsHistory } from "./useDetailsHistory";

const WEB = detailsTab("c1", DEPLOYMENTS, "shop", "web", "events");
const POD: DrawerTarget = {
  group: "",
  plural: "pods",
  namespace: "shop",
  name: "web-1",
};
const node = (name: string): DrawerTarget => ({
  group: "",
  plural: "nodes",
  namespace: null,
  name,
});

/** The hook on the store's copy of the tab, as the dock renders it. */
function useStoredTab(id: string) {
  const tab = useDock((s) => s.tabs.find((t) => t.id === id));
  return useDetailsHistory(tab as DetailsDockTab);
}

const stored = () => useDock.getState().tabs[0] as DetailsDockTab;

afterEach(() => {
  // Unmount before the reset, so no mounted hook reads a tab that is gone.
  cleanup();
  resetDockForTest();
});

test("the root is the tab's object, on the tab's drawer tab", () => {
  useDock.getState().open(WEB);
  const { result } = renderHook(() => useStoredTab(WEB.id));
  expect(result.current.root).toEqual({
    group: "apps",
    plural: "deployments",
    namespace: "shop",
    name: "web",
  });
  expect(result.current.shown).toEqual({
    target: result.current.root,
    tab: "events",
  });
  expect(result.current.previous).toBeNull();
});

test("a tab choice at the root is saved on the tab; on a linked entry it stays in memory, and Back restores it", () => {
  useDock.getState().open(WEB);
  const { result } = renderHook(() => useStoredTab(WEB.id));
  act(() => result.current.setTab("map"));
  expect(stored().tab).toBe("map");

  act(() => result.current.open(POD));
  expect(result.current.shown).toEqual({ target: POD, tab: "overview" });
  act(() => result.current.setTab("events"));
  expect(result.current.shown).toEqual({ target: POD, tab: "events" });
  expect(stored().tab).toBe("map");

  act(() => result.current.back());
  expect(result.current.shown?.tab).toBe("map");
  expect(result.current.previous).toBeNull();
  expect(result.current.step).toBe(2);
});

test("links keep 20 entries with the root, and the steps outlive an unmount until the tab closes", () => {
  useDock.getState().open(WEB);
  const first = renderHook(() => useStoredTab(WEB.id));
  for (let i = 0; i < 25; i += 1) {
    act(() => first.result.current.open(node(`n${i}`)));
  }
  expect(first.result.current.shown?.target.name).toBe("n24");
  first.unmount();

  // A cluster switch unmounts the panel; the steps are back when it returns.
  const again = renderHook(() => useStoredTab(WEB.id));
  expect(again.result.current.shown?.target.name).toBe("n24");
  expect(readDraft<unknown[]>(WEB.id)).toHaveLength(19);
  expect(shownDetailsEntry(stored())).toEqual({
    target: node("n24"),
    tab: "overview",
  });
  again.unmount();

  useDock.getState().close(WEB.id);
  expect(readDraft(WEB.id)).toBeUndefined();
});

test("with no linked entry the shown entry is the root on its saved tab", () => {
  useDock.getState().open(WEB);
  expect(shownDetailsEntry(stored())).toEqual({
    target: {
      group: "apps",
      plural: "deployments",
      namespace: "shop",
      name: "web",
    },
    tab: "events",
  });
});

test("opening the tab's object again drops its linked entries and shows the new drawer tab", () => {
  useDock.getState().open(WEB);
  const { result } = renderHook(() => useStoredTab(WEB.id));
  act(() => result.current.open(POD));
  act(() =>
    useDock
      .getState()
      .open(detailsTab("c1", DEPLOYMENTS, "shop", "web", "overview")),
  );
  expect(result.current.shown).toEqual({
    target: result.current.root,
    tab: "overview",
  });
  expect(result.current.previous).toBeNull();
});
