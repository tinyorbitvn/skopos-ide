import { beforeEach, expect, test } from "vitest";
import { focusedTab, tabPath } from "../app/tabs/layout";
import {
  resetWindowLayoutForTest,
  startLayout,
  useWindowLayout,
} from "./windowLayout";

beforeEach(() => resetWindowLayoutForTest());

test("a window starts with one Catalog tab in one pane", () => {
  const layout = startLayout("window-2");
  expect(layout.label).toBe("window-2");
  expect(layout.panes).toHaveLength(1);
  const tab = focusedTab(layout);
  expect(tab && tabPath(tab)).toBe("/catalog");
  expect(layout.panes[0].selected).toBe(tab?.id);
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
  const tab = focusedTab(useWindowLayout.getState().layout);
  expect(tab?.history).toEqual(["/catalog", "/preferences"]);
});
