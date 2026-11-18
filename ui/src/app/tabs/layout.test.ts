import { describe, expect, test } from "vitest";
import type { PaneState } from "../../ipc/generated/PaneState";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  dropAction,
  focusedTab,
  type LayoutAction,
  MAX_HISTORY,
  MIN_PANE_SHARE,
  type OpenMode,
  prune,
  reduce,
  tabPath,
} from "./layout";

function tab(id: string, path = `/p/${id}`, pinned = false): TabState {
  return { id, pinned, history: [path], index: 0 };
}

function pinned(id: string, path = `/p/${id}`): TabState {
  return tab(id, path, true);
}

function pane(id: string, tabs: TabState[], selected?: string): PaneState {
  return { id, width: 0, selected: selected ?? tabs[0]?.id ?? "", tabs };
}

/** A window of these panes with equal widths; `focused` is a pane index. */
function win(panes: PaneState[], focused = 0): WindowLayout {
  const share = 1 / panes.length;
  return {
    label: "main",
    bounds: null,
    panes: panes.map((p) => ({ ...p, width: share })),
    focusedPane: focused,
  };
}

/** `>p1:*t1^,t2 | p2:*t3`: `>` the focused pane, `*` the selected tab, `^` pinned. */
function shape(layout: WindowLayout): string {
  return layout.panes
    .map((p, i) => {
      const tabs = p.tabs
        .map(
          (t) =>
            `${p.selected === t.id ? "*" : ""}${t.id}${t.pinned ? "^" : ""}`,
        )
        .join(",");
      return `${i === layout.focusedPane ? ">" : ""}${p.id}:${tabs}`;
    })
    .join(" | ");
}

function widths(layout: WindowLayout): number[] {
  return layout.panes.map((p) => p.width);
}

function tabById(layout: WindowLayout, id: string): TabState {
  const found = layout.panes.flatMap((p) => p.tabs).find((t) => t.id === id);
  if (!found) throw new Error(`no tab ${id}`);
  return found;
}

function open(
  layout: WindowLayout,
  path: string,
  mode: OpenMode,
  fromTab?: string,
): WindowLayout {
  return reduce(layout, {
    type: "open",
    path,
    mode,
    newTabId: "new",
    newPaneId: "pnew",
    fromTab,
  });
}

describe("a plain click (P11)", () => {
  test("pushes the location onto the focused tab's history", () => {
    const l = win([pane("p1", [tab("t1", "/catalog"), tab("t2")])]);
    const next = open(l, "/cluster/a", "current");
    expect(shape(next)).toBe(">p1:*t1,t2");
    expect(tabById(next, "t1")).toMatchObject({
      history: ["/catalog", "/cluster/a"],
      index: 1,
    });
  });

  test("navigates the focused pane's tab, not another pane's", () => {
    const l = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])], 1);
    const next = open(l, "/preferences", "current");
    expect(tabPath(tabById(next, "t2"))).toBe("/preferences");
    expect(tabPath(tabById(next, "t1"))).toBe("/p/t1");
  });

  test("changes nothing when the tab already shows that location", () => {
    const l = win([pane("p1", [tab("t1", "/catalog")])]);
    expect(open(l, "/catalog", "current")).toBe(l);
  });

  test("drops the forward entries after going back", () => {
    const l = win([
      pane("p1", [
        { id: "t1", pinned: false, history: ["/a", "/b", "/c"], index: 0 },
      ]),
    ]);
    const next = open(l, "/d", "current");
    expect(tabById(next, "t1")).toMatchObject({
      history: ["/a", "/d"],
      index: 1,
    });
  });

  test("keeps at most 50 entries; the oldest drops", () => {
    const history = Array.from({ length: MAX_HISTORY }, (_, i) => `/h${i}`);
    const l = win([
      pane("p1", [{ id: "t1", pinned: false, history, index: 49 }]),
    ]);
    const t = tabById(open(l, "/new", "current"), "t1");
    expect(t.history).toHaveLength(MAX_HISTORY);
    expect(t.history[0]).toBe("/h1");
    expect(t.history.at(-1)).toBe("/new");
    expect(t.index).toBe(MAX_HISTORY - 1);
  });

  test("never navigates a pinned tab: a new tab opens right after the pinned ones", () => {
    const l = win([pane("p1", [pinned("t1"), pinned("t2"), tab("t3")], "t1")]);
    const next = open(l, "/cluster/a", "current");
    expect(shape(next)).toBe(">p1:t1^,t2^,*new,t3");
    expect(tabById(next, "t1").history).toEqual(["/p/t1"]);
    expect(tabById(next, "new")).toEqual({
      id: "new",
      pinned: false,
      history: ["/cluster/a"],
      index: 0,
    });
  });

  test("in a pinned tab, a change of the query only stays in the tab", () => {
    const l = win([
      pane("p1", [pinned("t1", "/cluster/a/r/apps/deployments")]),
    ]);
    const next = open(
      l,
      "/cluster/a/r/apps/deployments?object=ns%2Fx",
      "current",
    );
    expect(shape(next)).toBe(">p1:*t1^");
    expect(tabById(next, "t1").history).toEqual([
      "/cluster/a/r/apps/deployments",
      "/cluster/a/r/apps/deployments?object=ns%2Fx",
    ]);
  });

  test("opens a tab in an empty pane", () => {
    const l = win([pane("p1", [])]);
    expect(shape(open(l, "/catalog", "current"))).toBe(">p1:*new");
  });

  test("from a tab of another pane, it acts in that tab's pane and focuses it", () => {
    const l = win([pane("p1", [pinned("t1")]), pane("p2", [tab("t2")])], 1);
    const next = open(l, "/cluster/b", "current", "t1");
    expect(shape(next)).toBe(">p1:t1^,*new | p2:*t2");
  });
});

describe("Ctrl/Cmd+click (P12)", () => {
  test("opens a new tab at the end of the focused pane and selects it", () => {
    const l = win(
      [pane("p1", [tab("t1")]), pane("p2", [tab("t2"), tab("t3")], "t2")],
      1,
    );
    const next = open(l, "/cluster/a", "newTab");
    expect(shape(next)).toBe("p1:*t1 | >p2:t2,t3,*new");
    expect(tabPath(tabById(next, "new"))).toBe("/cluster/a");
  });

  test("opens after the pinned tabs too, even from a pinned tab", () => {
    const l = win([pane("p1", [pinned("t1")])]);
    expect(shape(open(l, "/x", "newTab"))).toBe(">p1:t1^,*new");
  });
});

describe("middle-click (P12)", () => {
  test("opens beside: in the pane right of the focused one, after its selected tab", () => {
    const l = win([
      pane("p1", [tab("t1")]),
      pane("p2", [tab("t2"), tab("t3")], "t2"),
    ]);
    const next = open(l, "/x", "beside");
    expect(shape(next)).toBe("p1:*t1 | >p2:t2,*new,t3");
  });

  test("opens a new pane on the right that takes half the focused pane's width", () => {
    const l = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])], 1);
    const next = open(l, "/x", "beside");
    expect(shape(next)).toBe("p1:*t1 | p2:*t2 | >pnew:*new");
    expect(widths(next)).toEqual([0.5, 0.25, 0.25]);
  });

  test("with 3 panes and the focused pane the rightmost, opens a new tab in it", () => {
    const l = win(
      [
        pane("p1", [tab("t1")]),
        pane("p2", [tab("t2")]),
        pane("p3", [tab("t3")]),
      ],
      2,
    );
    expect(shape(open(l, "/x", "beside"))).toBe(
      "p1:*t1 | p2:*t2 | >p3:t3,*new",
    );
  });

  test("in an empty window, opens the tab in the one pane", () => {
    const l = win([pane("p1", [])]);
    expect(shape(open(l, "/x", "beside"))).toBe(">p1:*new");
  });
});

describe("double-click on a navigation item (P13)", () => {
  test("navigates the focused tab and pins it after the pinned ones", () => {
    const l = win([pane("p1", [pinned("t1"), tab("t2"), tab("t3")], "t3")]);
    const next = open(l, "/cluster/a", "pin");
    expect(shape(next)).toBe(">p1:t1^,*t3^,t2");
    expect(tabById(next, "t3").history).toEqual(["/p/t3", "/cluster/a"]);
  });

  test("from a pinned tab, opens a new tab and pins it last among the pinned", () => {
    const l = win([pane("p1", [pinned("t1"), pinned("t2"), tab("t3")], "t1")]);
    const next = open(l, "/cluster/a", "pin");
    expect(shape(next)).toBe(">p1:t1^,t2^,*new^,t3");
  });

  test("on the tab that already shows the location, only pins it", () => {
    const l = win([pane("p1", [tab("t1", "/catalog")])]);
    const next = open(l, "/catalog", "pin");
    expect(shape(next)).toBe(">p1:*t1^");
    expect(tabById(next, "t1").history).toEqual(["/catalog"]);
  });
});

describe("pinned tabs (P13, P14)", () => {
  test("pinning moves the tab to the end of the pinned group, in pin order", () => {
    const l = win([pane("p1", [pinned("t1"), tab("t2"), tab("t3")])]);
    const next = reduce(l, { type: "pin", tabId: "t3" });
    expect(shape(next)).toBe(">p1:t1^,*t3^,t2");
  });

  test("unpinning moves the tab right after the pinned group", () => {
    const l = win([pane("p1", [pinned("t1"), pinned("t2"), tab("t3")])]);
    const next = reduce(l, { type: "unpin", tabId: "t1" });
    expect(shape(next)).toBe(">p1:t2^,*t1,t3");
  });

  test("pin and unpin change nothing when the tab already is so", () => {
    const l = win([pane("p1", [pinned("t1"), tab("t2")])]);
    expect(reduce(l, { type: "pin", tabId: "t1" })).toBe(l);
    expect(reduce(l, { type: "unpin", tabId: "t2" })).toBe(l);
  });

  test("a pinned tab cannot be closed", () => {
    const l = win([pane("p1", [pinned("t1"), tab("t2")])]);
    expect(reduce(l, { type: "close", tabId: "t1" })).toBe(l);
  });

  test("Close other tabs keeps the pinned tabs", () => {
    const l = win([
      pane("p1", [pinned("t1"), tab("t2"), tab("t3"), tab("t4")], "t1"),
    ]);
    const next = reduce(l, { type: "closeOthers", tabId: "t3" });
    expect(shape(next)).toBe(">p1:t1^,*t3");
  });

  test("Close other tabs with nothing to close changes nothing", () => {
    const l = win([pane("p1", [pinned("t1"), tab("t2")], "t2")]);
    expect(reduce(l, { type: "closeOthers", tabId: "t2" })).toBe(l);
  });
});

describe("closing (P21)", () => {
  test("selects the next tab, else the previous", () => {
    const l = win([pane("p1", [tab("t1"), tab("t2"), tab("t3")], "t2")]);
    expect(shape(reduce(l, { type: "close", tabId: "t2" }))).toBe(">p1:t1,*t3");
    const last = win([pane("p1", [tab("t1"), tab("t2")], "t2")]);
    expect(shape(reduce(last, { type: "close", tabId: "t2" }))).toBe(">p1:*t1");
  });

  test("closing a tab that is not selected keeps the selection", () => {
    const l = win([pane("p1", [tab("t1"), tab("t2")], "t2")]);
    expect(shape(reduce(l, { type: "close", tabId: "t1" }))).toBe(">p1:*t2");
  });

  test("a pane whose last tab leaves closes; the others share its width", () => {
    const l: WindowLayout = {
      ...win([
        pane("p1", [tab("t1")]),
        pane("p2", [tab("t2")]),
        pane("p3", [tab("t3")]),
      ]),
    };
    l.panes[0].width = 0.2;
    l.panes[1].width = 0.4;
    l.panes[2].width = 0.4;
    const next = reduce(l, { type: "close", tabId: "t3" });
    expect(shape(next)).toBe(">p1:*t1 | p2:*t2");
    expect(widths(next)).toEqual([0.3333, 0.6667]);
  });

  test("when the focused pane closes, focus goes to the pane on its right, else its left", () => {
    const three = win(
      [
        pane("p1", [tab("t1")]),
        pane("p2", [tab("t2")]),
        pane("p3", [tab("t3")]),
      ],
      1,
    );
    expect(shape(reduce(three, { type: "close", tabId: "t2" }))).toBe(
      "p1:*t1 | >p3:*t3",
    );
    const two = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])], 1);
    expect(shape(reduce(two, { type: "close", tabId: "t2" }))).toBe(">p1:*t1");
  });

  test("the last tab of the last pane leaves one empty pane", () => {
    const l = win([pane("p1", [tab("t1")])]);
    const next = reduce(l, { type: "close", tabId: "t1" });
    expect(next.panes).toEqual([
      { id: "p1", width: 1, selected: "", tabs: [] },
    ]);
    expect(focusedTab(next)).toBeNull();
  });

  test("an unknown tab id changes nothing", () => {
    const l = win([pane("p1", [tab("t1")])]);
    for (const action of [
      { type: "close", tabId: "x" },
      { type: "select", tabId: "x" },
      { type: "pin", tabId: "x" },
      { type: "move", tabId: "x", paneId: "p1", index: 0 },
      { type: "navigated", tabId: "x", history: ["/a"], index: 0 },
    ] as LayoutAction[]) {
      expect(reduce(l, action)).toBe(l);
    }
  });
});

describe("history (P3, P7)", () => {
  const l = win([
    pane("p1", [
      { id: "t1", pinned: false, history: ["/a", "/b", "/c"], index: 1 },
    ]),
  ]);

  test("back and forward move the focused tab's index", () => {
    expect(tabById(reduce(l, { type: "back" }), "t1").index).toBe(0);
    expect(tabById(reduce(l, { type: "forward" }), "t1").index).toBe(2);
  });

  test("back at the first entry and forward at the last change nothing", () => {
    const first = reduce(l, { type: "back" });
    expect(reduce(first, { type: "back" })).toBe(first);
    const last = reduce(l, { type: "forward" });
    expect(reduce(last, { type: "forward" })).toBe(last);
  });

  test("back in an empty window changes nothing", () => {
    const empty = win([pane("p1", [])]);
    expect(reduce(empty, { type: "back" })).toBe(empty);
  });

  test("navigated mirrors the tab router's history, keeping the last 50", () => {
    const next = reduce(l, {
      type: "navigated",
      tabId: "t1",
      history: ["/a", "/b", "/d"],
      index: 2,
    });
    expect(tabById(next, "t1")).toMatchObject({
      history: ["/a", "/b", "/d"],
      index: 2,
    });
    const long = Array.from({ length: 52 }, (_, i) => `/h${i}`);
    const trimmed = tabById(
      reduce(l, { type: "navigated", tabId: "t1", history: long, index: 51 }),
      "t1",
    );
    expect(trimmed.history).toEqual(long.slice(2));
    expect(trimmed.index).toBe(49);
  });

  test("navigated with the same history changes nothing", () => {
    expect(
      reduce(l, {
        type: "navigated",
        tabId: "t1",
        history: ["/a", "/b", "/c"],
        index: 1,
      }),
    ).toBe(l);
  });

  test("navigated does not move the focus", () => {
    const two = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])], 1);
    const next = reduce(two, {
      type: "navigated",
      tabId: "t1",
      history: ["/a", "/b"],
      index: 1,
    });
    expect(next.focusedPane).toBe(1);
  });
});

describe("focus and selection (P19)", () => {
  const l = win([pane("p1", [tab("t1"), tab("t2")]), pane("p2", [tab("t3")])]);

  test("selecting a tab focuses its pane", () => {
    expect(shape(reduce(l, { type: "select", tabId: "t3" }))).toBe(
      "p1:*t1,t2 | >p2:*t3",
    );
    expect(shape(reduce(l, { type: "select", tabId: "t2" }))).toBe(
      ">p1:t1,*t2 | p2:*t3",
    );
    expect(reduce(l, { type: "select", tabId: "t1" })).toBe(l);
  });

  test("focusing a pane", () => {
    expect(reduce(l, { type: "focusPane", paneId: "p2" }).focusedPane).toBe(1);
    expect(reduce(l, { type: "focusPane", paneId: "p1" })).toBe(l);
    expect(reduce(l, { type: "focusPane", paneId: "nope" })).toBe(l);
  });

  test("cycling wraps around in the focused pane", () => {
    expect(shape(reduce(l, { type: "cycle", delta: 1 }))).toBe(
      ">p1:t1,*t2 | p2:*t3",
    );
    expect(shape(reduce(l, { type: "cycle", delta: -1 }))).toBe(
      ">p1:t1,*t2 | p2:*t3",
    );
    const one = reduce(l, { type: "focusPane", paneId: "p2" });
    expect(reduce(one, { type: "cycle", delta: 1 })).toBe(one);
  });

  test("focusedTab and tabPath", () => {
    expect(focusedTab(l)?.id).toBe("t1");
    expect(
      tabPath({ id: "t", pinned: false, history: ["/a", "/b"], index: 1 }),
    ).toBe("/b");
  });
});

describe("moving tabs (P22)", () => {
  test("reorders within a pane, counting the index before the move", () => {
    const l = win([pane("p1", [tab("t1"), tab("t2"), tab("t3")])]);
    expect(
      shape(reduce(l, { type: "move", tabId: "t1", paneId: "p1", index: 3 })),
    ).toBe(">p1:t2,t3,*t1");
    expect(
      shape(reduce(l, { type: "move", tabId: "t3", paneId: "p1", index: 0 })),
    ).toBe(">p1:*t3,t1,t2");
  });

  test("moves into another pane at the index, selects it and focuses that pane", () => {
    const l = win([
      pane("p1", [tab("t1"), tab("t2")]),
      pane("p2", [tab("t3")]),
    ]);
    const next = reduce(l, {
      type: "move",
      tabId: "t1",
      paneId: "p2",
      index: 0,
    });
    expect(shape(next)).toBe("p1:*t2 | >p2:*t1,t3");
  });

  test("a drop inside the pinned group pins nothing and lands right after it", () => {
    const l = win([
      pane("p1", [pinned("t1"), pinned("t2")]),
      pane("p2", [tab("t3")]),
    ]);
    const next = reduce(l, {
      type: "move",
      tabId: "t3",
      paneId: "p1",
      index: 0,
    });
    expect(shape(next)).toBe(">p1:t1^,t2^,*t3");
    expect(tabById(next, "t3").pinned).toBe(false);
  });

  test("a pinned tab stays among the pinned ones", () => {
    const l = win([pane("p1", [pinned("t1"), tab("t2"), tab("t3")])]);
    const next = reduce(l, {
      type: "move",
      tabId: "t1",
      paneId: "p1",
      index: 3,
    });
    expect(shape(next)).toBe(">p1:*t1^,t2,t3");
    expect(next).toBe(
      reduce(next, { type: "move", tabId: "t1", paneId: "p1", index: 3 }),
    );
  });

  test("moving the last tab out closes its pane", () => {
    const l = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])]);
    const next = reduce(l, {
      type: "move",
      tabId: "t1",
      paneId: "p2",
      index: 1,
    });
    expect(shape(next)).toBe(">p2:t2,*t1");
    expect(widths(next)).toEqual([1]);
  });

  test("to a new pane on either side of a pane", () => {
    const l = win([pane("p1", [tab("t1"), tab("t2")])]);
    const right = reduce(l, {
      type: "moveToNewPane",
      tabId: "t2",
      paneId: "p1",
      side: "right",
      newPaneId: "pnew",
    });
    expect(shape(right)).toBe("p1:*t1 | >pnew:*t2");
    expect(widths(right)).toEqual([0.5, 0.5]);
    const left = reduce(l, {
      type: "moveToNewPane",
      tabId: "t2",
      paneId: "p1",
      side: "left",
      newPaneId: "pnew",
    });
    expect(shape(left)).toBe(">pnew:*t2 | p1:*t1");
  });

  test("a tab alone in its pane does not move beside its own pane", () => {
    const l = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])]);
    expect(
      reduce(l, {
        type: "moveToNewPane",
        tabId: "t1",
        paneId: "p1",
        side: "left",
        newPaneId: "x",
      }),
    ).toBe(l);
  });

  test("a tab alone in its pane moves beside another, and its pane closes", () => {
    const l = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])]);
    const next = reduce(l, {
      type: "moveToNewPane",
      tabId: "t1",
      paneId: "p2",
      side: "right",
      newPaneId: "pnew",
    });
    expect(shape(next)).toBe("p2:*t2 | >pnew:*t1");
    expect(widths(next)).toEqual([0.5, 0.5]);
  });
});

describe("splitting (P18, P20)", () => {
  test("copies the selected tab's location, not its history, into a new pane on the right", () => {
    const l = win([
      pane("p1", [{ id: "t1", pinned: true, history: ["/a", "/b"], index: 1 }]),
      pane("p2", [tab("t2")]),
    ]);
    const next = reduce(l, {
      type: "split",
      paneId: "p1",
      newTabId: "new",
      newPaneId: "pnew",
    });
    expect(shape(next)).toBe("p1:*t1^ | >pnew:*new | p2:*t2");
    expect(tabById(next, "new")).toEqual({
      id: "new",
      pinned: false,
      history: ["/b"],
      index: 0,
    });
    expect(widths(next)).toEqual([0.25, 0.25, 0.5]);
  });

  test("is refused at 3 panes and on a pane without tabs", () => {
    const three = win([
      pane("p1", [tab("t1")]),
      pane("p2", [tab("t2")]),
      pane("p3", [tab("t3")]),
    ]);
    expect(
      reduce(three, {
        type: "split",
        paneId: "p1",
        newTabId: "n",
        newPaneId: "pn",
      }),
    ).toBe(three);
    const empty = win([pane("p1", [])]);
    expect(
      reduce(empty, {
        type: "split",
        paneId: "p1",
        newTabId: "n",
        newPaneId: "pn",
      }),
    ).toBe(empty);
  });

  test("no action makes a fourth pane", () => {
    let l = win([pane("p1", [tab("t1"), tab("t2"), tab("t3"), tab("t4")])]);
    const actions: LayoutAction[] = [
      { type: "split", paneId: "p1", newTabId: "s1", newPaneId: "ps1" },
      { type: "split", paneId: "p1", newTabId: "s2", newPaneId: "ps2" },
      { type: "split", paneId: "p1", newTabId: "s3", newPaneId: "ps3" },
      {
        type: "moveToNewPane",
        tabId: "t2",
        paneId: "p1",
        side: "left",
        newPaneId: "pm",
      },
      { type: "focusPane", paneId: "ps1" },
      {
        type: "open",
        path: "/x",
        mode: "beside",
        newTabId: "b1",
        newPaneId: "pb",
      },
    ];
    for (const action of actions) {
      l = reduce(l, action);
      expect(l.panes.length).toBeLessThanOrEqual(3);
    }
  });

  test("a pane too narrow to halve makes the panes equal", () => {
    const l = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])]);
    l.panes[0].width = 0.3;
    l.panes[1].width = 0.7;
    const next = reduce(l, {
      type: "split",
      paneId: "p1",
      newTabId: "n",
      newPaneId: "pn",
    });
    expect(widths(next)).toEqual([0.3333, 0.3333, 0.3334]);
  });
});

describe("resizing (P18)", () => {
  const l = win([pane("p1", [tab("t1")]), pane("p2", [tab("t2")])]);

  test("moves the splitter between two panes, keeping each at the minimum or more", () => {
    expect(widths(reduce(l, { type: "resize", index: 0, share: 0.3 }))).toEqual(
      [0.3, 0.7],
    );
    expect(MIN_PANE_SHARE).toBe(0.18);
    expect(
      widths(reduce(l, { type: "resize", index: 0, share: 0.05 })),
    ).toEqual([0.18, 0.82]);
    expect(
      widths(reduce(l, { type: "resize", index: 0, share: 0.99 })),
    ).toEqual([0.82, 0.18]);
  });

  test("a resize that changes nothing, or of no splitter, returns the same layout", () => {
    expect(reduce(l, { type: "resize", index: 0, share: 0.5 })).toBe(l);
    expect(reduce(l, { type: "resize", index: 1, share: 0.3 })).toBe(l);
  });

  test("double-click makes the panes equal", () => {
    const moved = reduce(l, { type: "resize", index: 0, share: 0.3 });
    expect(widths(reduce(moved, { type: "equalize" }))).toEqual([0.5, 0.5]);
    expect(reduce(l, { type: "equalize" })).toBe(l);
  });

  test("every pane stays at the minimum or more and the widths add up to 1", () => {
    let layout = win([
      pane("p1", [tab("t1"), tab("t2"), tab("t3"), tab("t4")]),
    ]);
    const steps: LayoutAction[] = [
      { type: "split", paneId: "p1", newTabId: "a", newPaneId: "pa" },
      { type: "resize", index: 0, share: 0.01 },
      {
        type: "moveToNewPane",
        tabId: "t2",
        paneId: "p1",
        side: "left",
        newPaneId: "pb",
      },
      { type: "resize", index: 1, share: 0.9 },
      { type: "close", tabId: "a" },
      { type: "split", paneId: "p1", newTabId: "c", newPaneId: "pc" },
      { type: "resize", index: 1, share: 0.2 },
      { type: "move", tabId: "t2", paneId: "p1", index: 0 },
      {
        type: "open",
        path: "/x",
        mode: "beside",
        newTabId: "d",
        newPaneId: "pd",
      },
    ];
    for (const step of steps) {
      layout = reduce(layout, step);
      const all = widths(layout);
      expect(all.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 9);
      if (all.length > 1) {
        for (const w of all)
          expect(w).toBeGreaterThanOrEqual(MIN_PANE_SHARE - 1e-9);
      }
    }
  });
});

describe("prune (P39)", () => {
  const isRoute = (path: string) => !path.startsWith("/workspace");

  test("drops tabs whose path matches no route and closes the panes left empty", () => {
    const l = win([
      pane("p1", [tab("t1", "/workspace")]),
      pane("p2", [tab("t2", "/catalog")]),
    ]);
    const next = prune(l, isRoute);
    expect(shape(next)).toBe(">p2:*t2");
    expect(widths(next)).toEqual([1]);
  });

  test("drops unknown entries from a tab's history and keeps its place", () => {
    const l = win([
      pane("p1", [
        {
          id: "t1",
          pinned: false,
          history: ["/workspace", "/catalog", "/workspace/x", "/b"],
          index: 2,
        },
      ]),
    ]);
    expect(tabById(prune(l, isRoute), "t1")).toMatchObject({
      history: ["/catalog", "/b"],
      index: 0,
    });
  });

  test("everything gone leaves one empty pane", () => {
    const l = win([pane("p1", [tab("t1", "/workspace")])]);
    expect(prune(l, isRoute).panes).toEqual([
      { id: "p1", width: 1, selected: "", tabs: [] },
    ]);
  });

  test("returns the same layout when every path is known", () => {
    const l = win([pane("p1", [tab("t1", "/catalog")])]);
    expect(prune(l, isRoute)).toBe(l);
  });
});

describe("drop targets (P22)", () => {
  const two = win([
    pane("p1", [tab("t1"), tab("t2"), tab("t3")]),
    pane("p2", [tab("t4")]),
  ]);

  test("on its own strip: a reorder at the marked position, nothing where it is", () => {
    expect(
      dropAction(two, "t1", { kind: "strip", paneId: "p1", index: 3 }, "x"),
    ).toEqual({
      type: "move",
      tabId: "t1",
      paneId: "p1",
      index: 3,
    });
    expect(
      dropAction(two, "t1", { kind: "strip", paneId: "p1", index: 0 }, "x"),
    ).toBeNull();
    expect(
      dropAction(two, "t1", { kind: "strip", paneId: "p1", index: 1 }, "x"),
    ).toBeNull();
  });

  test("on another strip: a move into that pane at the marked position", () => {
    expect(
      dropAction(two, "t2", { kind: "strip", paneId: "p2", index: 0 }, "x"),
    ).toEqual({
      type: "move",
      tabId: "t2",
      paneId: "p2",
      index: 0,
    });
  });

  test("on a half of a pane's body: a new pane on that side", () => {
    expect(
      dropAction(two, "t2", { kind: "body", paneId: "p2", side: "left" }, "pn"),
    ).toEqual({
      type: "moveToNewPane",
      tabId: "t2",
      paneId: "p2",
      side: "left",
      newPaneId: "pn",
    });
    expect(
      dropAction(
        two,
        "t2",
        { kind: "body", paneId: "p1", side: "right" },
        "pn",
      ),
    ).toMatchObject({ type: "moveToNewPane", paneId: "p1", side: "right" });
  });

  test("on its own pane's body when it is that pane's only tab: nothing", () => {
    expect(
      dropAction(two, "t4", { kind: "body", paneId: "p2", side: "left" }, "pn"),
    ).toBeNull();
  });

  test("at 3 panes the body only takes the tab, at the end of that pane", () => {
    const three = win([
      pane("p1", [tab("t1"), tab("t2")]),
      pane("p2", [tab("t3")]),
      pane("p3", [tab("t4")]),
    ]);
    expect(
      dropAction(
        three,
        "t1",
        { kind: "body", paneId: "p3", side: "left" },
        "pn",
      ),
    ).toEqual({
      type: "move",
      tabId: "t1",
      paneId: "p3",
      index: 1,
    });
    expect(
      dropAction(
        three,
        "t1",
        { kind: "body", paneId: "p1", side: "right" },
        "pn",
      ),
    ).toBeNull();
  });

  test("an unknown tab or pane is no target", () => {
    expect(
      dropAction(two, "nope", { kind: "strip", paneId: "p1", index: 0 }, "x"),
    ).toBeNull();
    expect(
      dropAction(two, "t1", { kind: "strip", paneId: "nope", index: 0 }, "x"),
    ).toBeNull();
  });
});
