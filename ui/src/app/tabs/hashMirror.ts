import { useWindowLayout } from "../../stores/windowLayout";
import { focusedTab, tabPath } from "./layout";
import { openPath } from "./navigation";

function focusedPath(): string | null {
  const tab = focusedTab(useWindowLayout.getState().layout);
  return tab === null ? null : tabPath(tab);
}

/** The app location in the hash, or null when the hash holds none. */
function hashPath(): string | null {
  const path = window.location.hash.slice(1);
  return path.startsWith("/") && path !== "/" ? path : null;
}

/** The two forms of one location, one percent-encoded by the browser, are the same. */
function sameLocation(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return decodeURI(a) === decodeURI(b);
  } catch {
    return false;
  }
}

/** Writes the focused tab's location into the hash, without a history entry or an event. */
function show(): void {
  const path = focusedPath();
  const hash = window.location.hash.slice(1);
  if (path === null ? hash === "" : sameLocation(hash, path)) return;
  const { pathname, search } = window.location;
  const url = path === null ? `${pathname}${search}` : `#${path}`;
  window.history.replaceState(window.history.state, "", url);
}

/** Navigates the focused tab to the location in the hash, as a plain click does (P11). */
function follow(isRoute: (path: string) => boolean): void {
  const path = hashPath();
  const shown = focusedPath();
  if (path !== null && (shown === null || !sameLocation(path, shown))) {
    if (isRoute(path)) openPath(path, "current");
  }
  show();
}

/**
 * Keeps the URL hash on the focused tab's location, and navigates that tab when
 * something else sets the hash (spec P5). The hash the page loaded with is applied
 * first. A hash no route knows is put back. Returns a function that stops it.
 */
export function installHashMirror(
  isRoute: (path: string) => boolean,
): () => void {
  follow(isRoute);
  const onHashChange = () => follow(isRoute);
  window.addEventListener("hashchange", onHashChange);
  const unsubscribe = useWindowLayout.subscribe((state, previous) => {
    if (state.layout !== previous.layout) show();
  });
  return () => {
    window.removeEventListener("hashchange", onHashChange);
    unsubscribe();
  };
}
