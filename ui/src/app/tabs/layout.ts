/**
 * One window's layout (spec P11 to P22, P39): 1 to 3 panes side by side, each with its
 * own tabs, and each tab with its own history of locations. Pure: `reduce` and `prune`
 * return a new layout, or the same object when an action is refused or changes
 * nothing, so a store can compare by identity. New ids come in the actions.
 */
import type { PaneState } from "../../ipc/generated/PaneState";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";

export const MAX_PANES = 3;
/** A tab's history keeps this many entries; older ones drop (P7). */
export const MAX_HISTORY = 50;
/** The smallest share of the window width a pane takes (P18). */
export const MIN_PANE_SHARE = 0.18;

/**
 * How a navigation item opens its location: a plain click (`current`, P11), Ctrl or
 * Cmd+click (`newTab`, P12), middle-click (`beside`, P12) or double-click (`pin`, P13).
 */
export type OpenMode = "current" | "newTab" | "beside" | "pin";

export type Side = "left" | "right";

export type LayoutAction =
  | {
      type: "open";
      path: string;
      mode: OpenMode;
      newTabId: string;
      newPaneId: string;
      /** The tab the navigation comes from; the focused pane's tab when absent. */
      fromTab?: string;
    }
  /** The tab's own router moved: its history and position, as the router has them. */
  | { type: "navigated"; tabId: string; history: string[]; index: number }
  | { type: "back"; tabId?: string }
  | { type: "forward"; tabId?: string }
  | { type: "select"; tabId: string }
  | { type: "focusPane"; paneId: string }
  | { type: "cycle"; delta: 1 | -1 }
  | { type: "pin"; tabId: string }
  | { type: "unpin"; tabId: string }
  | { type: "close"; tabId: string }
  | { type: "closeOthers"; tabId: string }
  /** `index` counts the strip before the tab leaves it. */
  | { type: "move"; tabId: string; paneId: string; index: number }
  | {
      type: "moveToNewPane";
      tabId: string;
      paneId: string;
      side: Side;
      newPaneId: string;
    }
  /** A copy of the pane's selected location in a new pane on its right (P20). */
  | { type: "split"; paneId: string; newTabId: string; newPaneId: string }
  /** `share` is the new width of the pane left of splitter `index`. */
  | { type: "resize"; index: number; share: number }
  | { type: "equalize" };

/** Where a dragged tab is let go inside its window (P22). */
export type DropTarget =
  /** A strip, at the marked position counted before the tab leaves it. */
  | { kind: "strip"; paneId: string; index: number }
  /** The left or right half of a pane's body. */
  | { kind: "body"; paneId: string; side: Side };

/** The location a tab shows: a path with its query. */
export function tabPath(tab: TabState): string {
  return tab.history[tab.index] ?? tab.history.at(-1) ?? "";
}

export function focusedPane(layout: WindowLayout): PaneState | null {
  return layout.panes[layout.focusedPane] ?? layout.panes[0] ?? null;
}

/** The focused pane's selected tab, or null in an empty window. */
export function focusedTab(layout: WindowLayout): TabState | null {
  const pane = focusedPane(layout);
  return pane?.tabs.find((t) => t.id === pane.selected) ?? null;
}

export interface TabPlace {
  pane: PaneState;
  paneIndex: number;
  tab: TabState;
  tabIndex: number;
}

export function findTab(layout: WindowLayout, tabId: string): TabPlace | null {
  for (const [paneIndex, pane] of layout.panes.entries()) {
    const tabIndex = pane.tabs.findIndex((t) => t.id === tabId);
    if (tabIndex >= 0) {
      return { pane, paneIndex, tab: pane.tabs[tabIndex], tabIndex };
    }
  }
  return null;
}

/** A mutable copy of a layout whose focus is a pane id, so panes can come and go. */
interface Draft {
  layout: WindowLayout;
  focus: string;
}

function draftOf(layout: WindowLayout): Draft {
  const copy = structuredClone(layout);
  return { layout: copy, focus: focusedPane(copy)?.id ?? "" };
}

function pathname(path: string): string {
  const at = path.search(/[?#]/);
  return at < 0 ? path : path.slice(0, at);
}

function pinnedCount(pane: PaneState, except?: string): number {
  return pane.tabs.filter((t) => t.pinned && t.id !== except).length;
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(Math.max(n, low), high);
}

/** Puts a tab at `index`, among the pinned tabs if pinned and after them if not, and selects it. */
function insert(pane: PaneState, tab: TabState, index: number): void {
  const pinned = pinnedCount(pane, tab.id);
  const at = tab.pinned
    ? clamp(index, 0, pinned)
    : clamp(index, pinned, pane.tabs.length);
  pane.tabs.splice(at, 0, tab);
  pane.selected = tab.id;
}

/** Takes a tab out of its pane; a selected tab hands the selection to the next, else the previous. */
function take(pane: PaneState, tabIndex: number): TabState {
  const [tab] = pane.tabs.splice(tabIndex, 1);
  if (pane.selected === tab.id) {
    pane.selected = (pane.tabs[tabIndex] ?? pane.tabs[tabIndex - 1])?.id ?? "";
  }
  return tab;
}

function newTab(id: string, path: string): TabState {
  return { id, pinned: false, history: [path], index: 0 };
}

/** Keeps the last `MAX_HISTORY` entries, moving the index with them. */
function trimmed(tab: TabState): void {
  const extra = tab.history.length - MAX_HISTORY;
  if (extra <= 0) return;
  tab.history = tab.history.slice(extra);
  tab.index = Math.max(0, tab.index - extra);
}

/** The new location after the shown one; the entries after it drop. */
function push(tab: TabState, path: string): void {
  tab.history = [...tab.history.slice(0, tab.index + 1), path];
  tab.index = tab.history.length - 1;
  trimmed(tab);
}

function setPinned(pane: PaneState, tab: TabState, pinned: boolean): void {
  pane.tabs.splice(pane.tabs.indexOf(tab), 1);
  tab.pinned = pinned;
  insert(pane, tab, pinnedCount(pane, tab.id));
}

/** A new pane at `at` holding `tab`, focused, with half the width of `ref`. */
function addPane(
  draft: Draft,
  at: number,
  tab: TabState,
  ref: PaneState,
  id: string,
): void {
  const width = ref.width / 2;
  ref.width = width;
  draft.layout.panes.splice(at, 0, {
    id,
    width,
    selected: tab.id,
    tabs: [tab],
  });
  draft.focus = id;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Rounded to 4 places, with the rounding left on the last pane so they add up to 1. */
function settle(widths: number[]): number[] {
  const head = widths.slice(0, -1).map(round4);
  return [...head, round4(1 - head.reduce((sum, w) => sum + w, 0))];
}

function equalWidths(count: number): number[] {
  return settle(Array.from({ length: count }, () => 1 / count));
}

/**
 * Restores the invariants after any change: pinned tabs first, valid positions and
 * selections, no empty pane beside others (the others share its width, and its focus
 * goes to the pane on its right, else its left), a valid focus, and widths of at
 * least `MIN_PANE_SHARE` that add up to 1.
 */
function normalize(draft: Draft): WindowLayout {
  const { layout } = draft;
  for (const pane of layout.panes) {
    pane.tabs = [
      ...pane.tabs.filter((t) => t.pinned),
      ...pane.tabs.filter((t) => !t.pinned),
    ];
    for (const tab of pane.tabs) {
      tab.index = clamp(tab.index, 0, Math.max(0, tab.history.length - 1));
    }
    if (!pane.tabs.some((t) => t.id === pane.selected)) {
      pane.selected = pane.tabs[0]?.id ?? "";
    }
  }
  for (let i = layout.panes.length - 1; i >= 0; i--) {
    if (layout.panes.length === 1) break;
    if (layout.panes[i].tabs.length > 0) continue;
    const [gone] = layout.panes.splice(i, 1);
    if (gone.id === draft.focus) {
      draft.focus = (layout.panes[i] ?? layout.panes[i - 1]).id;
    }
  }
  const index = layout.panes.findIndex((p) => p.id === draft.focus);
  layout.focusedPane = Math.max(0, index);
  let widths = layout.panes.map((p) =>
    Number.isFinite(p.width) && p.width > 0 ? p.width : 0,
  );
  const sum = widths.reduce((s, w) => s + w, 0);
  if (widths.some((w) => w === 0) || sum <= 0) {
    widths = equalWidths(widths.length);
  } else {
    widths = widths.map((w) => w / sum);
    if (widths.length > 1 && widths.some((w) => w < MIN_PANE_SHARE - 1e-9)) {
      widths = equalWidths(widths.length);
    }
  }
  settle(widths).forEach((w, i) => {
    layout.panes[i].width = w;
  });
  return layout;
}

/** The normalized draft, or the original when nothing changed. */
function finish(original: WindowLayout, draft: Draft): WindowLayout {
  const next = normalize(draft);
  return JSON.stringify(next) === JSON.stringify(original) ? original : next;
}

/** Runs `change` on a draft with the tab's place; false refuses the action. */
function update(
  layout: WindowLayout,
  tabId: string,
  change: (draft: Draft, place: TabPlace) => boolean,
): WindowLayout {
  const draft = draftOf(layout);
  const place = findTab(draft.layout, tabId);
  if (!place || !change(draft, place)) return layout;
  return finish(layout, draft);
}

function open(
  layout: WindowLayout,
  action: Extract<LayoutAction, { type: "open" }>,
): WindowLayout {
  const draft = draftOf(layout);
  const panes = draft.layout.panes;
  const from = action.fromTab ? findTab(draft.layout, action.fromTab) : null;
  const pane =
    from?.pane ?? panes.find((p) => p.id === draft.focus) ?? panes[0];
  if (!pane) return layout;
  const tab =
    from?.tab ?? pane.tabs.find((t) => t.id === pane.selected) ?? null;
  draft.focus = pane.id;
  const fresh = newTab(action.newTabId, action.path);

  switch (action.mode) {
    case "current":
    case "pin": {
      let target = fresh;
      // A pinned tab keeps its pathname (P11): only a query change stays in it.
      const stays =
        tab !== null &&
        (!tab.pinned || pathname(tabPath(tab)) === pathname(action.path));
      if (tab !== null && stays) {
        if (tabPath(tab) !== action.path) push(tab, action.path);
        target = tab;
        pane.selected = tab.id;
      } else {
        insert(pane, fresh, pinnedCount(pane));
      }
      if (action.mode === "pin" && !target.pinned)
        setPinned(pane, target, true);
      break;
    }
    case "newTab":
      insert(pane, fresh, pane.tabs.length);
      break;
    case "beside": {
      const index = panes.indexOf(pane);
      const right = panes[index + 1];
      if (right) {
        const selected = right.tabs.findIndex((t) => t.id === right.selected);
        insert(right, fresh, selected < 0 ? right.tabs.length : selected + 1);
        draft.focus = right.id;
      } else if (pane.tabs.length > 0 && panes.length < MAX_PANES) {
        addPane(draft, index + 1, fresh, pane, action.newPaneId);
      } else {
        insert(pane, fresh, pane.tabs.length);
      }
      break;
    }
  }
  return finish(layout, draft);
}

function step(
  layout: WindowLayout,
  delta: number,
  tabId?: string,
): WindowLayout {
  const id = tabId ?? focusedTab(layout)?.id;
  if (id === undefined) return layout;
  return update(layout, id, (_draft, { tab }) => {
    const index = tab.index + delta;
    if (index < 0 || index >= tab.history.length) return false;
    tab.index = index;
    return true;
  });
}

function move(
  layout: WindowLayout,
  tabId: string,
  paneId: string,
  index: number,
): WindowLayout {
  return update(layout, tabId, (draft, { pane: source, tabIndex }) => {
    const target = draft.layout.panes.find((p) => p.id === paneId);
    if (!target) return false;
    const tab = take(source, tabIndex);
    insert(
      target,
      tab,
      source === target && tabIndex < index ? index - 1 : index,
    );
    draft.focus = target.id;
    return true;
  });
}

function moveToNewPane(
  layout: WindowLayout,
  action: Extract<LayoutAction, { type: "moveToNewPane" }>,
): WindowLayout {
  if (layout.panes.length >= MAX_PANES) return layout;
  return update(layout, action.tabId, (draft, { pane: source, tabIndex }) => {
    const panes = draft.layout.panes;
    const target = panes.find((p) => p.id === action.paneId);
    if (!target) return false;
    // Alone in its own pane, the tab would only end up where it is.
    if (target === source && source.tabs.length === 1) return false;
    const tab = take(source, tabIndex);
    const at = panes.indexOf(target) + (action.side === "right" ? 1 : 0);
    addPane(draft, at, tab, target, action.newPaneId);
    return true;
  });
}

function split(
  layout: WindowLayout,
  action: Extract<LayoutAction, { type: "split" }>,
): WindowLayout {
  if (layout.panes.length >= MAX_PANES) return layout;
  const draft = draftOf(layout);
  const panes = draft.layout.panes;
  const pane = panes.find((p) => p.id === action.paneId);
  const tab = pane?.tabs.find((t) => t.id === pane.selected);
  if (!pane || !tab) return layout;
  const copy = newTab(action.newTabId, tabPath(tab));
  addPane(draft, panes.indexOf(pane) + 1, copy, pane, action.newPaneId);
  return finish(layout, draft);
}

function resize(
  layout: WindowLayout,
  index: number,
  share: number,
): WindowLayout {
  const { panes } = layout;
  if (index < 0 || index >= panes.length - 1) return layout;
  const pair = panes[index].width + panes[index + 1].width;
  const left = round4(clamp(share, MIN_PANE_SHARE, pair - MIN_PANE_SHARE));
  if (left === panes[index].width) return layout;
  const draft = draftOf(layout);
  draft.layout.panes[index].width = left;
  draft.layout.panes[index + 1].width = round4(pair - left);
  return finish(layout, draft);
}

export function reduce(
  layout: WindowLayout,
  action: LayoutAction,
): WindowLayout {
  switch (action.type) {
    case "open":
      return open(layout, action);
    case "navigated":
      if (action.history.length === 0) return layout;
      return update(layout, action.tabId, (_draft, { tab }) => {
        tab.history = [...action.history];
        tab.index = clamp(action.index, 0, action.history.length - 1);
        trimmed(tab);
        return true;
      });
    case "back":
      return step(layout, -1, action.tabId);
    case "forward":
      return step(layout, 1, action.tabId);
    case "select":
      return update(layout, action.tabId, (draft, { pane, tab }) => {
        pane.selected = tab.id;
        draft.focus = pane.id;
        return true;
      });
    case "focusPane": {
      const index = layout.panes.findIndex((p) => p.id === action.paneId);
      if (index < 0 || index === layout.focusedPane) return layout;
      return { ...layout, focusedPane: index };
    }
    case "cycle": {
      const pane = focusedPane(layout);
      if (!pane || pane.tabs.length < 2) return layout;
      const at = pane.tabs.findIndex((t) => t.id === pane.selected);
      const count = pane.tabs.length;
      const next = pane.tabs[(at + action.delta + count) % count];
      return reduce(layout, { type: "select", tabId: next.id });
    }
    case "pin":
    case "unpin":
      return update(layout, action.tabId, (draft, { pane, tab }) => {
        const pinned = action.type === "pin";
        if (tab.pinned === pinned) return false;
        setPinned(pane, tab, pinned);
        draft.focus = pane.id;
        return true;
      });
    case "close":
      return update(layout, action.tabId, (_draft, { pane, tab, tabIndex }) => {
        if (tab.pinned) return false;
        take(pane, tabIndex);
        return true;
      });
    case "closeOthers":
      return update(layout, action.tabId, (draft, { pane, tab }) => {
        pane.tabs = pane.tabs.filter((t) => t.pinned || t.id === tab.id);
        pane.selected = tab.id;
        draft.focus = pane.id;
        return true;
      });
    case "move":
      return move(layout, action.tabId, action.paneId, action.index);
    case "moveToNewPane":
      return moveToNewPane(layout, action);
    case "split":
      return split(layout, action);
    case "resize":
      return resize(layout, action.index, action.share);
    case "equalize": {
      const draft = draftOf(layout);
      equalWidths(layout.panes.length).forEach((w, i) => {
        draft.layout.panes[i].width = w;
      });
      return finish(layout, draft);
    }
  }
}

/**
 * Drops the history entries whose path matches no route (P39), the tabs left without
 * one, and the panes left empty. A tab whose shown entry drops shows the nearest
 * earlier entry that stays, else its first.
 */
export function prune(
  layout: WindowLayout,
  isRoute: (path: string) => boolean,
): WindowLayout {
  const draft = draftOf(layout);
  for (const pane of draft.layout.panes) {
    for (const tab of pane.tabs) {
      const before = tab.history.slice(0, tab.index + 1).filter(isRoute).length;
      tab.history = tab.history.filter(isRoute);
      tab.index = Math.max(0, before - 1);
    }
    pane.tabs = pane.tabs.filter((t) => t.history.length > 0);
  }
  return finish(layout, draft);
}

/**
 * The layout change for letting a dragged tab go on a target, or null when it changes
 * nothing (P22). At 3 panes a pane's body takes the tab at the end of that pane.
 */
export function dropAction(
  layout: WindowLayout,
  tabId: string,
  target: DropTarget,
  newPaneId: string,
): LayoutAction | null {
  const from = findTab(layout, tabId);
  const pane = layout.panes.find((p) => p.id === target.paneId);
  if (!from || !pane) return null;
  let action: LayoutAction;
  if (target.kind === "strip") {
    action = { type: "move", tabId, paneId: pane.id, index: target.index };
  } else if (layout.panes.length >= MAX_PANES) {
    if (pane === from.pane) return null;
    action = { type: "move", tabId, paneId: pane.id, index: pane.tabs.length };
  } else {
    action = {
      type: "moveToNewPane",
      tabId,
      paneId: pane.id,
      side: target.side,
      newPaneId,
    };
  }
  return reduce(layout, action) === layout ? null : action;
}
