import { expect, test } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { reduce } from "./layout";
import { tabMenu } from "./tabMenu";

function tab(id: string, pinned = false): TabState {
  return { id, pinned, history: [`/cluster/${id}`], index: 0 };
}

function layoutOf(panes: TabState[][]): WindowLayout {
  return {
    label: "main",
    bounds: null,
    panes: panes.map((tabs, i) => ({
      id: `p${i + 1}`,
      width: 1 / panes.length,
      selected: tabs[0]?.id ?? "",
      tabs,
    })),
    focusedPane: 0,
  };
}

/** `id: label (reason)` per item, or `id: label [hint]` when it applies. */
function read(layout: WindowLayout, tabId: string, mac = false): string[] {
  return tabMenu(layout, tabId, "p-new", mac).map(
    (item) =>
      `${item.id}: ${item.label}${
        item.reason !== null
          ? ` (${item.reason})`
          : item.hint
            ? ` [${item.hint}]`
            : ""
      }`,
  );
}

test("one pane with two tabs: no pane on either side (P15)", () => {
  const layout = layoutOf([[tab("a"), tab("b")]]);
  expect(read(layout, "a")).toEqual([
    "pin: Pin tab [Double-click]",
    "left: Move to the left pane (No pane on the left)",
    "right: Move to the right pane (No pane on the right)",
    "new-pane: Move to a new pane on the right",
    "close: Close [Ctrl+W]",
    "close-others: Close other tabs [Keeps pinned tabs]",
  ]);
  expect(read(layout, "a", true)[4]).toBe("close: Close [⌘W]");
});

test("a pinned tab unpins and cannot be closed; Close other tabs keeps pinned ones (P14, P15)", () => {
  const layout = layoutOf([[tab("a", true), tab("b", true)]]);
  expect(read(layout, "a")).toEqual([
    "pin: Unpin tab [Double-click]",
    "left: Move to the left pane (No pane on the left)",
    "right: Move to the right pane (No pane on the right)",
    "new-pane: Move to a new pane on the right",
    "close: Close (Pinned tabs cannot be closed)",
    "close-others: Close other tabs (No other tabs to close)",
  ]);
});

test("a tab alone in its pane cannot move to a new pane, and has no other tabs to close", () => {
  const layout = layoutOf([[tab("a")], [tab("b")]]);
  expect(read(layout, "b")).toEqual([
    "pin: Pin tab [Double-click]",
    "left: Move to the left pane",
    "right: Move to the right pane (No pane on the right)",
    "new-pane: Move to a new pane on the right (It is the only tab in its pane)",
    "close: Close [Ctrl+W]",
    "close-others: Close other tabs (No other tabs to close)",
  ]);
});

test("at 3 panes a new pane is refused first; the middle pane's tab moves both ways", () => {
  const layout = layoutOf([[tab("a")], [tab("b"), tab("c")], [tab("d")]]);
  const items = read(layout, "b");
  expect(items[1]).toBe("left: Move to the left pane");
  expect(items[2]).toBe("right: Move to the right pane");
  expect(items[3]).toBe(
    "new-pane: Move to a new pane on the right (3 panes at most)",
  );
  expect(read(layoutOf([[tab("a")], [tab("b")], [tab("d")]]), "b")[3]).toBe(
    "new-pane: Move to a new pane on the right (3 panes at most)",
  );
});

test("the moves go to the end of the pane beside, and to a new pane right of the tab's own", () => {
  const layout = layoutOf([[tab("a")], [tab("b"), tab("c")], [tab("d")]]);
  const actions = Object.fromEntries(
    tabMenu(layout, "c", "p-new").map((i) => [i.id, i.action]),
  );
  expect(actions.left).toEqual({
    type: "move",
    tabId: "c",
    paneId: "p1",
    index: 1,
  });
  expect(actions.right).toEqual({
    type: "move",
    tabId: "c",
    paneId: "p3",
    index: 1,
  });
  expect(actions["new-pane"]).toBeNull();
  const two = layoutOf([[tab("a"), tab("b")]]);
  expect(
    tabMenu(two, "b", "p-new").find((i) => i.id === "new-pane")?.action,
  ).toEqual({
    type: "moveToNewPane",
    tabId: "b",
    paneId: "p1",
    side: "right",
    newPaneId: "p-new",
  });
});

test("an item that applies has an action that changes the layout; one that does not has none", () => {
  const layouts = [
    layoutOf([[tab("a"), tab("b")]]),
    layoutOf([[tab("a", true), tab("b")], [tab("c")]]),
    layoutOf([[tab("a")], [tab("b", true), tab("c")], [tab("d")]]),
  ];
  for (const layout of layouts) {
    for (const pane of layout.panes) {
      for (const t of pane.tabs) {
        for (const item of tabMenu(layout, t.id, "p-new")) {
          const changes =
            item.action !== null && reduce(layout, item.action) !== layout;
          expect([t.id, item.id, changes, item.action === null]).toEqual([
            t.id,
            item.id,
            item.reason === null,
            item.reason !== null,
          ]);
        }
      }
    }
  }
});

test("an unknown tab has no menu", () => {
  expect(tabMenu(layoutOf([[tab("a")]]), "zz", "p-new")).toEqual([]);
});
