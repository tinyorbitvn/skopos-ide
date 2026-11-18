import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  createMemoryRouter,
  type Location,
  type NavigationType,
  Outlet,
  parsePath,
  type RouteObject,
  RouterProvider,
  useBlocker,
} from "react-router";
import { EmptyState } from "../../design";
import type { TabState } from "../../ipc/generated/TabState";
import { useWindowLayout } from "../../stores/windowLayout";
import { MAX_HISTORY, tabPath } from "./layout";
import { clearPendingState, openPath, peekPendingState } from "./navigation";
import { tabRoutes } from "./routes";

export type TabRouter = ReturnType<typeof createMemoryRouter>;

/** The routers of the mounted tabs, by tab id: the header goes back and forward through them. */
export const tabRouters = new Map<string, TabRouter>();

/** Moves a tab through its own history: through its router when it is mounted. */
export function goInTab(tabId: string, delta: -1 | 1): void {
  const router = tabRouters.get(tabId);
  if (router) {
    void router.navigate(delta);
    return;
  }
  useWindowLayout
    .getState()
    .dispatch({ type: delta < 0 ? "back" : "forward", tabId });
}

export interface TabContextValue {
  tabId: string;
  pinned: boolean;
}

const TabContext = createContext<TabContextValue | null>(null);

/** The tab a screen renders in, or null outside a tab. */
export function useTabContext(): TabContextValue | null {
  return useContext(TabContext);
}

/** What the router of a tab holds, as the layout writes it: paths with their query. */
interface Mirror {
  keys: string[];
  paths: string[];
  index: number;
}

interface Runtime {
  router: TabRouter;
  mirror: Mirror;
}

let runs = 0;

function createRuntime(tab: TabState, routes: RouteObject[]): Runtime {
  runs += 1;
  const keys = tab.history.map((_, i) => `r${runs}-${i}`);
  const state = peekPendingState(tab.id, tabPath(tab)) ?? null;
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <TabRoot />,
        errorElement: <TabRouteError />,
        children: routes,
      },
    ],
    {
      initialEntries: tab.history.map((path, i) => ({
        ...parsePath(path),
        key: keys[i],
        state: i === tab.index ? state : null,
      })),
      initialIndex: tab.index,
    },
  );
  return {
    router,
    mirror: { keys, paths: [...tab.history], index: tab.index },
  };
}

/** Applies a router location to the mirror; false when the location did not change. */
function follow(
  mirror: Mirror,
  location: Location,
  action: NavigationType,
): boolean {
  const { key } = location;
  if (key === mirror.keys[mirror.index]) return false;
  const path = location.pathname + location.search;
  if (action === "POP") {
    const at = mirror.keys.indexOf(key);
    if (at >= 0) {
      mirror.index = at;
    } else {
      // An entry older than the kept 50 shows as the first one.
      mirror.index = 0;
      mirror.keys[0] = key;
      mirror.paths[0] = path;
    }
  } else if (action === "REPLACE") {
    mirror.keys[mirror.index] = key;
    mirror.paths[mirror.index] = path;
  } else {
    mirror.keys = [...mirror.keys.slice(0, mirror.index + 1), key];
    mirror.paths = [...mirror.paths.slice(0, mirror.index + 1), path];
    const extra = mirror.keys.length - MAX_HISTORY;
    if (extra > 0) {
      mirror.keys = mirror.keys.slice(extra);
      mirror.paths = mirror.paths.slice(extra);
    }
    mirror.index = mirror.keys.length - 1;
  }
  return true;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Whether the tab's history is the mirror's with one location pushed after the shown one. */
function pushed(mirror: Mirror, tab: TabState): boolean {
  if (tab.index !== tab.history.length - 1 || tab.history.length < 2) {
    return false;
  }
  const kept = mirror.paths.slice(0, mirror.index + 1);
  const before = tab.history.slice(0, -1);
  const dropped = kept.length - before.length;
  return (dropped === 0 || dropped === 1) && same(before, kept.slice(dropped));
}

/**
 * The root of a tab's routes. A pinned tab never changes its pathname (spec P11): a
 * navigation inside it that would is blocked and opens a new tab instead. Back and
 * forward still move through the pinned tab's own history.
 */
function TabRoot() {
  const tab = useTabContext();
  const pinned = tab?.pinned ?? false;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation, historyAction }) =>
      pinned &&
      historyAction !== "POP" &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked" || tab === null) return;
    const { pathname, search, state } = blocker.location;
    blocker.reset();
    openPath(pathname + search, "current", {
      fromTab: tab.tabId,
      state: state ?? undefined,
    });
  }, [blocker, tab]);
  return <Outlet />;
}

function TabRouteError() {
  return (
    <EmptyState
      title="Nothing to show"
      body="This location is not a screen of the app."
    />
  );
}

/**
 * One tab's screen in its own memory router (spec D5, P7, P8), made from the tab's
 * history when it mounts. Every move of the router is written back to the layout, and
 * a change of the layout (a navigation item, back, forward) moves the router.
 */
export function TabView(props: { tab: TabState; routes?: RouteObject[] }) {
  const { tab } = props;
  const [routes] = useState(() => props.routes ?? tabRoutes());
  const [runtime, setRuntime] = useState(() => createRuntime(tab, routes));
  const { router, mirror } = runtime;

  // The router to the layout.
  useEffect(() => {
    clearPendingState(tab.id);
    tabRouters.set(tab.id, router);
    const unsubscribe = router.subscribe((state) => {
      if (!follow(mirror, state.location, state.historyAction)) return;
      useWindowLayout.getState().dispatch({
        type: "navigated",
        tabId: tab.id,
        history: [...mirror.paths],
        index: mirror.index,
      });
    });
    return () => {
      unsubscribe();
      if (tabRouters.get(tab.id) === router) tabRouters.delete(tab.id);
    };
  }, [router, mirror, tab.id]);

  // The layout to the router.
  useEffect(() => {
    const unchanged = same(tab.history, mirror.paths);
    if (unchanged && tab.index === mirror.index) return;
    const path = tabPath(tab);
    const state = peekPendingState(tab.id, path);
    // Location state comes only with a new location, which a push can make look like
    // a step forward.
    if (state !== undefined || (!unchanged && pushed(mirror, tab))) {
      clearPendingState(tab.id);
      void router.navigate(path, { state });
    } else if (unchanged) {
      void router.navigate(tab.index - mirror.index);
    } else {
      setRuntime(createRuntime(tab, routes));
    }
  }, [tab, mirror, router, routes]);

  const context = useMemo(
    () => ({ tabId: tab.id, pinned: tab.pinned }),
    [tab.id, tab.pinned],
  );
  return (
    <TabContext.Provider value={context}>
      <RouterProvider router={router} />
    </TabContext.Provider>
  );
}
