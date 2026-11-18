import { type MouseEvent, useMemo } from "react";
import { useWindowLayout } from "../../stores/windowLayout";
import { IS_MAC } from "../shortcuts";
import { focusedTab, type OpenMode } from "./layout";

/** Location state waiting for the router of the tab that got the location. */
const pendingStates = new Map<string, { path: string; state: unknown }>();

/** The state `openPath` left for this tab's location at `path`, if any. */
export function peekPendingState(tabId: string, path: string): unknown {
  const pending = pendingStates.get(tabId);
  return pending?.path === path ? pending.state : undefined;
}

export function clearPendingState(tabId: string): void {
  pendingStates.delete(tabId);
}

export interface OpenOptions {
  /** The tab the navigation comes from, when it starts inside a screen. */
  fromTab?: string;
  /** Location state for the new location, such as the drawer's tab. */
  state?: unknown;
}

/**
 * Opens a location in this window under spec P11 to P13, and returns the id of the
 * tab that shows it (the focused tab afterwards), or null in an empty window.
 */
export function openPath(
  path: string,
  mode: OpenMode,
  options: OpenOptions = {},
): string | null {
  const store = useWindowLayout.getState();
  const before = store.layout;
  store.dispatch({
    type: "open",
    path,
    mode,
    newTabId: crypto.randomUUID(),
    newPaneId: crypto.randomUUID(),
    fromTab: options.fromTab,
  });
  const after = useWindowLayout.getState().layout;
  const tab = focusedTab(after);
  if (tab === null) return null;
  if (options.state !== undefined && after !== before) {
    pendingStates.set(tab.id, { path, state: options.state });
  }
  return tab.id;
}

interface Click {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * How a click opens a navigation item: middle-click beside, Ctrl+click (Cmd+click on
 * macOS) in a new tab, any other left click in the focused tab. Null for other buttons.
 */
export function clickMode(event: Click, mac = IS_MAC): OpenMode | null {
  if (event.button === 1) return "beside";
  if (event.button !== 0) return null;
  return (mac ? event.metaKey : event.ctrlKey) ? "newTab" : "current";
}

export interface NavItemHandlers {
  onClick(event: MouseEvent): void;
  onAuxClick(event: MouseEvent): void;
  onMouseDown(event: MouseEvent): void;
  onDoubleClick(event: MouseEvent): void;
}

/**
 * The handlers of a navigation item (a sidebar entry, a rail tile, a palette entry):
 * click, Ctrl/Cmd+click, middle-click and double-click (spec P11 to P13). Each one
 * prevents the default, so a router link inside keeps out of it.
 */
export function navItemHandlers(path: string, mac = IS_MAC): NavItemHandlers {
  return {
    onClick(event) {
      const mode = clickMode(event, mac);
      if (mode === null) return;
      event.preventDefault();
      openPath(path, mode);
    },
    onAuxClick(event) {
      if (event.button !== 1) return;
      event.preventDefault();
      openPath(path, "beside");
    },
    onMouseDown(event) {
      // A middle press would start the browser's autoscroll.
      if (event.button === 1) event.preventDefault();
    },
    onDoubleClick(event) {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      openPath(path, "pin");
    },
  };
}

export function useNavItem(path: string): NavItemHandlers {
  return useMemo(() => navItemHandlers(path), [path]);
}

/** The app location of the link an event happened in, or null outside a link. */
export function linkPath(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest("a[href]");
  if (link === null) return null;
  const href = link.getAttribute("href") ?? "";
  // A tab's router writes plain paths, the shell's router hash paths.
  const path = href.startsWith("#") ? href.slice(1) : href;
  return path.startsWith("/") ? path : null;
}

export interface ScreenLinkHandlers {
  onClickCapture(event: MouseEvent): void;
  onAuxClickCapture(event: MouseEvent): void;
  onMouseDownCapture(event: MouseEvent): void;
  onDoubleClickCapture(event: MouseEvent): void;
}

/**
 * Catches the links inside a tab's screen at its pane body, in the capture phase: a
 * plain click stays with the tab's router; Ctrl/Cmd+click opens a new tab, middle-click
 * beside, and a click with Shift or Alt stays in the tab instead of leaving the app.
 * A double-click pins the tab that shows the link's location (spec P11 to P13).
 */
export function screenLinkHandlers(
  tabId: string,
  mac = IS_MAC,
): ScreenLinkHandlers {
  return {
    onClickCapture(event) {
      if (event.button !== 0) return;
      const modified =
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
      if (!modified) return;
      const path = linkPath(event.target);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      const mode = clickMode(event, mac) === "newTab" ? "newTab" : "current";
      openPath(path, mode, { fromTab: tabId });
    },
    onAuxClickCapture(event) {
      if (event.button !== 1) return;
      const path = linkPath(event.target);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      openPath(path, "beside", { fromTab: tabId });
    },
    onMouseDownCapture(event) {
      if (event.button === 1 && linkPath(event.target) !== null) {
        event.preventDefault();
      }
    },
    onDoubleClickCapture(event) {
      if (event.ctrlKey || event.metaKey) return;
      const path = linkPath(event.target);
      if (path === null) return;
      // The first click already showed the location in the focused tab.
      openPath(path, "pin");
    },
  };
}
