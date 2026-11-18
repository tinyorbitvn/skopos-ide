import { type ReactNode, useMemo } from "react";
import {
  createPath,
  type Navigator,
  parsePath,
  Router,
  type To,
} from "react-router";
import { useWindowLayout } from "../../stores/windowLayout";
import { focusedTab, tabPath } from "./layout";
import { openPath } from "./navigation";
import { goInTab, tabRouters } from "./TabView";

function pathOf(to: To): string {
  return typeof to === "string" ? to : createPath(to);
}

/**
 * Sends a location to the focused tab under P11. New state for the location the tab
 * already shows (the dock opening the drawer it shows on another tab) goes straight to
 * the tab's router, since the layout has nothing to change.
 */
function navigateFocused(path: string, state: unknown): void {
  const tab = focusedTab(useWindowLayout.getState().layout);
  const router = tab === null ? undefined : tabRouters.get(tab.id);
  if (state != null && tab !== null && router && tabPath(tab) === path) {
    void router.navigate(path, { state, replace: true });
    return;
  }
  openPath(path, "current", { state: state ?? undefined });
}

/**
 * Navigation from outside the tabs (spec P3, P11): a location goes to the focused tab,
 * as a plain click on a navigation item does, and back and forward move that tab.
 */
export const shellNavigator: Navigator = {
  createHref: (to) => `#${pathOf(to)}`,
  push: (to, state) => navigateFocused(pathOf(to), state),
  replace: (to, state) => navigateFocused(pathOf(to), state),
  go: (delta) => {
    const tab = focusedTab(useWindowLayout.getState().layout);
    if (tab !== null && delta !== 0) goInTab(tab.id, delta < 0 ? -1 : 1);
  },
};

/** The focused tab's location, or null in an empty window. */
export function useFocusedPath(): string | null {
  return useWindowLayout((s) => {
    const tab = focusedTab(s.layout);
    return tab === null ? null : tabPath(tab);
  });
}

/**
 * A router for a part of the window's shell (the rail, the header, the sidebar, the
 * dock, the palette): its location is the focused tab's, so links and matches follow
 * that tab, and its navigation goes to the focused tab. A tab's own router cannot sit
 * inside it, so each part of the shell gets one.
 */
export function ShellRouter({ children }: { children: ReactNode }) {
  const path = useFocusedPath() ?? "/";
  const location = useMemo(
    () => ({ ...parsePath(path), state: null, key: path }),
    [path],
  );
  return (
    <Router location={location} navigator={shellNavigator}>
      {children}
    </Router>
  );
}
