import { create } from "zustand";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import type { WindowBounds } from "../../ipc/generated/WindowBounds";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { MAIN_WINDOW } from "../../ipc/window";
import { flushWindowLayout, useWindowLayout } from "../../stores/windowLayout";
import { tabPath } from "./layout";
import { tabInfo } from "./routes";

/** How far below and right of this window a new one opens, in logical pixels. */
export const NEW_WINDOW_STEP = 32;

/** Another window "Move to window ▸" offers (spec P15). */
export interface WindowChoice {
  label: string;
  /** "Main window" or "Window ‹n›". */
  name: string;
  /** The title of its focused tab, or "No tabs". */
  title: string;
}

/** A window's name in menus: "Main window", or "Window ‹n›" for `window-‹n›`. */
export function windowName(label: string): string {
  if (label === MAIN_WINDOW) return "Main window";
  const number = /^window-(\d+)$/.exec(label)?.[1];
  return number === undefined ? label : `Window ${number}`;
}

function focusedTitle(
  layout: WindowLayout,
  clusters: readonly ClusterEntry[],
): string {
  const pane = layout.panes[layout.focusedPane] ?? layout.panes[0];
  const tab =
    pane?.tabs.find((t) => t.id === pane.selected) ?? pane?.tabs[0] ?? null;
  return tab === null ? "No tabs" : tabInfo(tabPath(tab), clusters).title;
}

/** Every window but `own`, in the core's order (main first), each with its focused tab. */
export function windowChoices(
  layouts: readonly WindowLayout[],
  own: string,
  clusters: readonly ClusterEntry[],
): WindowChoice[] {
  return layouts
    .filter((l) => l.label !== own)
    .map((l) => ({
      label: l.label,
      name: windowName(l.label),
      title: focusedTitle(l, clusters),
    }));
}

/**
 * Where a new window opens (physical pixels, as `MoveTarget` takes them): a step below
 * and right of this window's outer corner, or of its screen position (logical pixels)
 * when its bounds are not known yet.
 */
export function newWindowPoint(
  own: WindowBounds | null,
  scale: number,
  screen: { x: number; y: number },
): { x: number; y: number } {
  if (own !== null) {
    const step = Math.round(NEW_WINDOW_STEP * scale);
    return { x: own.x + step, y: own.y + step };
  }
  return {
    x: Math.round((screen.x + NEW_WINDOW_STEP) * scale),
    y: Math.round((screen.y + NEW_WINDOW_STEP) * scale),
  };
}

/** The windows' layouts as the core last listed them; read when a tab menu opens. */
export const useWindowList = create<{ layouts: WindowLayout[] }>()(() => ({
  layouts: [],
}));

let listSeq = 0;

/** Reads every window's layout from the core; the last read wins, a failure keeps the old list. */
export async function refreshWindowList(): Promise<void> {
  const seq = ++listSeq;
  try {
    const layouts = await api.windowsList();
    if (seq === listSeq) useWindowList.setState({ layouts });
  } catch {
    // The menu then offers the windows it knew, and a move to a closed one says so.
  }
}

/**
 * Moves a tab of this window into another window's focused pane (spec P31, P33). The
 * pending save goes first, so it cannot put the tab back; the core's layout event then
 * takes the tab out here. A failure, such as "That window is closed.", is a toast and
 * the tab stays (P44).
 */
export async function moveTabToWindow(
  tabId: string,
  label: string,
): Promise<void> {
  await flushWindowLayout();
  try {
    await api.windowTabMove(tabId, { kind: "window", label });
  } catch (error) {
    toast.error(failureMessage(error));
  }
}

async function ownBounds(): Promise<WindowBounds | null> {
  const own = useWindowLayout.getState().label;
  try {
    const layouts = await api.windowsList();
    return layouts.find((l) => l.label === own)?.bounds ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens a tab in a new window beside this one (spec P15, P17). A window that cannot be
 * created says why in a toast, and the tab stays (P44).
 */
export async function openInNewWindow(tabId: string): Promise<void> {
  const point = newWindowPoint(await ownBounds(), window.devicePixelRatio, {
    x: window.screenX,
    y: window.screenY,
  });
  await flushWindowLayout();
  try {
    await api.windowTabMove(tabId, { kind: "newWindow", ...point });
  } catch (error) {
    toast.error(failureMessage(error));
  }
}

export function resetWindowListForTest(): void {
  listSeq = 0;
  useWindowList.setState({ layouts: [] });
}
