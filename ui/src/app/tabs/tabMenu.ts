import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { IS_MAC, shortKeys } from "../shortcuts";
import { findTab, type LayoutAction, MAX_PANES } from "./layout";
import type { WindowChoice } from "./windowMoves";

export type TabMenuId =
  | "pin"
  | "left"
  | "right"
  | "new-pane"
  | "window"
  | "close"
  | "close-others";

export interface TabMenuItem {
  id: TabMenuId;
  label: string;
  /** A key or a note, shown while the item applies. */
  hint?: string;
  /** Why the item does not apply (its tooltip), or null when it does. */
  reason: string | null;
  /** The change choosing it makes; null when it does not apply or opens a submenu. */
  action: LayoutAction | null;
  /** "Move to window ▸": its submenu, whose moves go through the core (P31, P33). */
  windows?: TabMenuWindow[];
}

/** Where an item of "Move to window ▸" sends the tab. */
export type WindowTarget = { kind: "window"; label: string } | { kind: "new" };

/** An item of "Move to window ▸": another window, or "New window". */
export interface TabMenuWindow {
  /** `window-‹label›`, or `window-new`. */
  id: string;
  label: string;
  /** The title of that window's focused tab. */
  hint?: string;
  target: WindowTarget;
}

function item(
  id: TabMenuId,
  label: string,
  reason: string | null,
  action: LayoutAction | null,
  hint?: string,
): TabMenuItem {
  return { id, label, hint, reason, action: reason === null ? action : null };
}

/**
 * A tab's menu (spec P15), in its order: pin or unpin, the moves inside the window,
 * "Move to window ▸" (the other `windows`, then "New window"), and the closes. An item
 * that cannot apply says why. `newPaneId` names the pane "Move to a new pane on the
 * right" makes.
 */
export function tabMenu(
  layout: WindowLayout,
  tabId: string,
  newPaneId: string,
  options: { mac?: boolean; windows?: readonly WindowChoice[] } = {},
): TabMenuItem[] {
  const { mac = IS_MAC, windows = [] } = options;
  const place = findTab(layout, tabId);
  if (place === null) return [];
  const { pane, paneIndex, tab } = place;
  const left = layout.panes[paneIndex - 1];
  const right = layout.panes[paneIndex + 1];
  const toEnd = (target: typeof pane | undefined): LayoutAction | null =>
    target === undefined
      ? null
      : { type: "move", tabId, paneId: target.id, index: target.tabs.length };
  const newPaneReason =
    layout.panes.length >= MAX_PANES
      ? "3 panes at most"
      : pane.tabs.length < 2
        ? "It is the only tab in its pane"
        : null;
  const others = pane.tabs.some((t) => !t.pinned && t.id !== tabId);
  return [
    item(
      "pin",
      tab.pinned ? "Unpin tab" : "Pin tab",
      null,
      { type: tab.pinned ? "unpin" : "pin", tabId },
      "Double-click",
    ),
    item(
      "left",
      "Move to the left pane",
      left ? null : "No pane on the left",
      toEnd(left),
    ),
    item(
      "right",
      "Move to the right pane",
      right ? null : "No pane on the right",
      toEnd(right),
    ),
    item("new-pane", "Move to a new pane on the right", newPaneReason, {
      type: "moveToNewPane",
      tabId,
      paneId: pane.id,
      side: "right",
      newPaneId,
    }),
    {
      ...item("window", "Move to window", null, null),
      windows: [
        ...windows.map(
          (w): TabMenuWindow => ({
            id: `window-${w.label}`,
            label: w.name,
            hint: w.title,
            target: { kind: "window", label: w.label },
          }),
        ),
        { id: "window-new", label: "New window", target: { kind: "new" } },
      ],
    },
    item(
      "close",
      "Close",
      tab.pinned ? "Pinned tabs cannot be closed" : null,
      { type: "close", tabId },
      shortKeys("closeTab", mac),
    ),
    item(
      "close-others",
      "Close other tabs",
      others ? null : "No other tabs to close",
      { type: "closeOthers", tabId },
      "Keeps pinned tabs",
    ),
  ];
}
