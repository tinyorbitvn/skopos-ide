/**
 * Where a dragged tab lands (spec P22): the targets under the pointer, the zones each
 * pane body shows, and the label that says what letting go does. The page marks its
 * targets with data attributes: a body zone `data-drop-zone` (left, right or here)
 * and `data-drop-pane`; a tab `data-drop-pane` and `data-drop-index`; a strip
 * `data-drop-pane` and `data-drop-count`. While a tab is dragged, a pane body that
 * offers no zone is `data-drop-refused="true"`.
 */
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  type DropTarget,
  dropAction,
  findTab,
  type LayoutAction,
  MAX_PANES,
  type Side,
} from "./layout";

/** A press moves this far, in pixels, before it drags the tab (P22). */
export const DRAG_THRESHOLD = 6;

/** What letting go does: a change inside the window, or the move out of it (P31). */
export type DropOver =
  | { kind: "inside"; target: DropTarget; action: LayoutAction }
  | { kind: "outside" };

/** A body's zone: one of its halves, or at 3 panes the whole body ("here"). */
export type ZoneKind = Side | "here";

function attribute(el: Element, name: string): string {
  return el.getAttribute(name) ?? "";
}

/** The target an element under the pointer at `x` belongs to, or null. */
export function targetAt(el: Element | null, x: number): DropTarget | null {
  if (el === null) return null;
  const zone = el.closest("[data-drop-zone]");
  if (zone !== null) {
    return {
      kind: "body",
      paneId: attribute(zone, "data-drop-pane"),
      side: attribute(zone, "data-drop-zone") === "left" ? "left" : "right",
    };
  }
  const tab = el.closest("[data-drop-index]");
  if (tab !== null) {
    const box = tab.getBoundingClientRect();
    const index = Number(attribute(tab, "data-drop-index"));
    return {
      kind: "strip",
      paneId: attribute(tab, "data-drop-pane"),
      index: x > box.left + box.width / 2 ? index + 1 : index,
    };
  }
  const strip = el.closest("[data-drop-count]");
  if (strip !== null) {
    return {
      kind: "strip",
      paneId: attribute(strip, "data-drop-pane"),
      index: Number(attribute(strip, "data-drop-count")),
    };
  }
  return null;
}

/**
 * Whether the element under the pointer lies in a pane body that offers no zone, where
 * the drop is refused rather than only cancelled (spec Q §5).
 */
export function refusedAt(el: Element | null): boolean {
  if (el === null) return false;
  return el.closest('[data-drop-refused="true"]') !== null;
}

/** Whether a point in client pixels lies outside this window's page. */
export function outsideWindow(
  x: number,
  y: number,
  width = window.innerWidth,
  height = window.innerHeight,
): boolean {
  return x < 0 || y < 0 || x >= width || y >= height;
}

/** Letting go at `target`, or null when that changes nothing. */
export function overAt(
  layout: WindowLayout,
  tabId: string,
  target: DropTarget | null,
  newPaneId: string,
): DropOver | null {
  if (target === null) return null;
  const action = dropAction(layout, tabId, target, newPaneId);
  return action === null ? null : { kind: "inside", target, action };
}

/** The zones pane `paneId`'s body shows while `tabId` is dragged. */
export function dropZones(
  layout: WindowLayout,
  tabId: string,
  paneId: string,
): ZoneKind[] {
  const can = (side: Side) =>
    dropAction(layout, tabId, { kind: "body", paneId, side }, "zone") !== null;
  if (layout.panes.length >= MAX_PANES) return can("right") ? ["here"] : [];
  return (["left", "right"] as const).filter(can);
}

/** The line beside the pointer while dragging (P22). */
export function dropLabel(over: DropOver | null): string {
  if (over === null) return "Let go here to cancel";
  if (over.kind === "outside") {
    return "Let go: into the window there, or a new window";
  }
  const { action, target } = over;
  if (action.type === "moveToNewPane") {
    return `Let go: new pane on the ${action.side}`;
  }
  return target.kind === "body"
    ? "Let go: move to this pane"
    : "Let go to place it here";
}

/**
 * Where a strip shows its mark for a strip target, counted in the strip as it shows:
 * pinned tabs stay first, so an unpinned tab marks right after them and a pinned one
 * no later (P22).
 */
export function markIndex(
  layout: WindowLayout,
  tabId: string,
  target: Extract<DropTarget, { kind: "strip" }>,
): number {
  const pane = layout.panes.find((p) => p.id === target.paneId);
  const from = findTab(layout, tabId);
  if (pane === undefined || from === null) return target.index;
  const same = from.pane.id === pane.id;
  // As the reducer counts it: once the tab has left its strip.
  const at =
    same && from.tabIndex < target.index ? target.index - 1 : target.index;
  const pinned = pane.tabs.filter((t) => t.pinned && t.id !== tabId).length;
  const lands = from.tab.pinned ? Math.min(at, pinned) : Math.max(at, pinned);
  return same && lands >= from.tabIndex ? lands + 1 : lands;
}
