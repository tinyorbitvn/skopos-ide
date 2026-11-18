import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { installHashMirror } from "./hashMirror";
import { focusedTab, tabPath } from "./layout";

const isRoute = (path: string) => !path.startsWith("/workspace");

function tab(id: string, history: string[], pinned = false): TabState {
  return { id, pinned, history, index: history.length - 1 };
}

function layoutOf(tabs: TabState[]): WindowLayout {
  return {
    label: "main",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: tabs[0]?.id ?? "", tabs }],
    focusedPane: 0,
  };
}

function focusedPath(): string | null {
  const shown = focusedTab(useWindowLayout.getState().layout);
  return shown === null ? null : tabPath(shown);
}

function setHash(hash: string): void {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

let stop: () => void = () => {};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  resetWindowLayoutForTest(layoutOf([tab("t1", ["/catalog"])]));
});

afterEach(() => {
  stop();
  window.history.replaceState(null, "", "/");
});

test("the hash shows the focused tab's location and follows it (P5)", () => {
  stop = installHashMirror(isRoute);
  expect(window.location.hash).toBe("#/catalog");
  act(() =>
    useWindowLayout.getState().dispatch({
      type: "open",
      path: "/cluster/c1/r/apps/deployments?q=web",
      mode: "current",
      newTabId: "t2",
      newPaneId: "p2",
    }),
  );
  expect(window.location.hash).toBe("#/cluster/c1/r/apps/deployments?q=web");
});

test("an empty window has no hash", () => {
  resetWindowLayoutForTest(layoutOf([]));
  window.history.replaceState(null, "", "/#/catalog");
  stop = installHashMirror(() => false);
  expect(window.location.hash).toBe("");
});

test("setting the hash navigates the focused tab, as a plain click does (P5, P11)", () => {
  stop = installHashMirror(isRoute);
  setHash("#/preferences");
  expect(focusedPath()).toBe("/preferences");
  const shown = focusedTab(useWindowLayout.getState().layout);
  expect(shown?.id).toBe("t1");
  expect(shown?.history).toEqual(["/catalog", "/preferences"]);
});

test("a hash in a pinned tab opens a new tab after it (P11)", () => {
  resetWindowLayoutForTest(layoutOf([tab("t1", ["/catalog"], true)]));
  stop = installHashMirror(isRoute);
  setHash("#/preferences");
  const { panes } = useWindowLayout.getState().layout;
  expect(panes[0].tabs.map((t) => tabPath(t))).toEqual([
    "/catalog",
    "/preferences",
  ]);
  expect(focusedPath()).toBe("/preferences");
});

test("a hash no route knows is put back", () => {
  stop = installHashMirror(isRoute);
  setHash("#/workspace");
  expect(focusedPath()).toBe("/catalog");
  expect(window.location.hash).toBe("#/catalog");
});

test("the hash the page loaded with is applied once", () => {
  window.history.replaceState(null, "", "/#/preferences");
  stop = installHashMirror(isRoute);
  expect(focusedPath()).toBe("/preferences");
  expect(focusedTab(useWindowLayout.getState().layout)?.history).toEqual([
    "/catalog",
    "/preferences",
  ]);
});

test("the hash of the location already shown changes nothing", () => {
  window.history.replaceState(null, "", "/#/catalog");
  const before = useWindowLayout.getState().layout;
  stop = installHashMirror(isRoute);
  setHash("#/catalog");
  expect(useWindowLayout.getState().layout).toBe(before);
});

test("after stopping, the hash is left alone", () => {
  installHashMirror(isRoute)();
  setHash("#/preferences");
  expect(focusedPath()).toBe("/catalog");
});
