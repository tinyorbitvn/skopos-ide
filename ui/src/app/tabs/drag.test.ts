import { afterEach, expect, test } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  dropLabel,
  dropZones,
  markIndex,
  outsideWindow,
  overAt,
  refusedAt,
  targetAt,
} from "./drag";

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

afterEach(() => {
  document.body.replaceChildren();
});

function element(attrs: Record<string, string>, box?: DOMRect): HTMLElement {
  const el = document.createElement("div");
  for (const [name, value] of Object.entries(attrs))
    el.setAttribute(name, value);
  if (box) el.getBoundingClientRect = () => box;
  return el;
}

test("the element under the pointer names the target: a zone, a tab's half, or a strip's end", () => {
  const zone = element({ "data-drop-zone": "left", "data-drop-pane": "p2" });
  const here = element({ "data-drop-zone": "here", "data-drop-pane": "p3" });
  const strip = element({ "data-drop-pane": "p1", "data-drop-count": "3" });
  const tabBox = new DOMRect(100, 0, 80, 32);
  const tabEl = element(
    { "data-drop-pane": "p1", "data-drop-index": "1" },
    tabBox,
  );
  const label = document.createElement("span");
  tabEl.append(label);
  strip.append(tabEl);
  document.body.append(zone, here, strip);

  expect(targetAt(zone, 0)).toEqual({
    kind: "body",
    paneId: "p2",
    side: "left",
  });
  // At 3 panes a body takes the tab whatever the side.
  expect(targetAt(here, 0)).toEqual({
    kind: "body",
    paneId: "p3",
    side: "right",
  });
  expect(targetAt(label, 120)).toEqual({
    kind: "strip",
    paneId: "p1",
    index: 1,
  });
  expect(targetAt(label, 150)).toEqual({
    kind: "strip",
    paneId: "p1",
    index: 2,
  });
  expect(targetAt(strip, 400)).toEqual({
    kind: "strip",
    paneId: "p1",
    index: 3,
  });
  expect(targetAt(document.body, 0)).toBeNull();
  expect(targetAt(null, 0)).toBeNull();
});

test("a point outside the page is outside the window", () => {
  expect(
    [
      [10, 10],
      [-1, 10],
      [10, -1],
      [800, 10],
      [10, 600],
      [799, 599],
    ].map(([x, y]) => outsideWindow(x, y, 800, 600)),
  ).toEqual([false, true, true, true, true, false]);
});

test("each body shows halves, the whole body at 3 panes, or nothing where letting go changes nothing (P22)", () => {
  const two = layoutOf([[tab("a"), tab("b")], [tab("c")]]);
  expect(dropZones(two, "b", "p1")).toEqual(["left", "right"]);
  expect(dropZones(two, "b", "p2")).toEqual(["left", "right"]);
  // Alone in its pane, the tab would land where it is.
  expect(dropZones(two, "c", "p2")).toEqual([]);
  const three = layoutOf([[tab("a"), tab("b")], [tab("c")], [tab("d")]]);
  expect(dropZones(three, "b", "p1")).toEqual([]);
  expect(dropZones(three, "b", "p2")).toEqual(["here"]);
  expect(dropZones(three, "b", "p3")).toEqual(["here"]);
  expect(dropZones(two, "zz", "p1")).toEqual([]);
});

test("a target that changes nothing is no drop", () => {
  const layout = layoutOf([[tab("a"), tab("b")], [tab("c")]]);
  expect(
    overAt(layout, "a", { kind: "strip", paneId: "p1", index: 1 }, "n"),
  ).toBeNull();
  expect(
    overAt(layout, "a", { kind: "strip", paneId: "p1", index: 2 }, "n"),
  ).toEqual({
    kind: "inside",
    target: { kind: "strip", paneId: "p1", index: 2 },
    action: { type: "move", tabId: "a", paneId: "p1", index: 2 },
  });
  expect(
    overAt(layout, "c", { kind: "body", paneId: "p2", side: "left" }, "n"),
  ).toBeNull();
});

test("the label beside the pointer says what letting go does (P22, P31)", () => {
  const two = layoutOf([[tab("a"), tab("b")], [tab("c")]]);
  const three = layoutOf([[tab("a"), tab("b")], [tab("c")], [tab("d")]]);
  const inside = (layout: WindowLayout, target: Parameters<typeof overAt>[2]) =>
    dropLabel(overAt(layout, "b", target, "n"));
  expect(dropLabel(null)).toBe("Let go here to cancel");
  expect(dropLabel({ kind: "outside" })).toBe(
    "Let go: into the window there, or a new window",
  );
  expect(inside(two, { kind: "strip", paneId: "p2", index: 0 })).toBe(
    "Let go to place it here",
  );
  expect(inside(two, { kind: "body", paneId: "p2", side: "left" })).toBe(
    "Let go: new pane on the left",
  );
  expect(inside(two, { kind: "body", paneId: "p1", side: "right" })).toBe(
    "Let go: new pane on the right",
  );
  expect(inside(three, { kind: "body", paneId: "p3", side: "right" })).toBe(
    "Let go: move to this pane",
  );
});

test("the strip's mark shows where the tab lands: pinned tabs stay first (P22)", () => {
  const layout = layoutOf([
    [tab("p", true), tab("q", true), tab("a")],
    [tab("b")],
  ]);
  // An unpinned tab dropped inside the pinned group lands right after it.
  expect(
    markIndex(layout, "b", { kind: "strip", paneId: "p1", index: 0 }),
  ).toBe(2);
  expect(
    markIndex(layout, "b", { kind: "strip", paneId: "p1", index: 3 }),
  ).toBe(3);
  // A pinned tab stays among the pinned ones.
  const pinned = layoutOf([
    [tab("p", true), tab("a")],
    [tab("q", true), tab("b")],
  ]);
  expect(
    markIndex(pinned, "q", { kind: "strip", paneId: "p1", index: 2 }),
  ).toBe(1);
  // In its own strip the tab is still shown: the mark counts it.
  const own = layoutOf([[tab("p", true), tab("q", true), tab("a")]]);
  expect(markIndex(own, "p", { kind: "strip", paneId: "p1", index: 3 })).toBe(
    2,
  );
});

test("a body that offers no zone refuses the drop; anywhere else letting go only cancels (spec Q §5)", () => {
  const refused = element({ "data-drop-refused": "true" });
  const content = document.createElement("p");
  refused.append(content);
  const open = element({ "data-drop-refused": "false" });
  document.body.append(refused, open);

  expect(refusedAt(content)).toBe(true);
  expect(refusedAt(refused)).toBe(true);
  expect(refusedAt(open)).toBe(false);
  expect(refusedAt(document.body)).toBe(false);
  expect(refusedAt(null)).toBe(false);
});
