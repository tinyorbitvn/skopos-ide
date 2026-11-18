import { useEffect, useMemo, useRef, useState } from "react";
import { Button, PaneHandle, Spinner, StatusDot } from "../design";
import { AboutDialog } from "../features/about/AboutDialog";
import { ClusterNav } from "../features/cluster/ClusterNav";
import { Dock } from "../features/dock/Dock";
import { CommandPalette } from "../features/palette/CommandPalette";
import { ShortcutsDialog } from "../features/shortcuts/ShortcutsDialog";
import { events } from "../ipc/events";
import { useCatalog } from "../stores/catalog";
import { useClusterState, useConnect } from "../stores/clusters";
import { NAV_PANE, usePaneSize } from "../stores/paneSize";
import { useApiResources } from "../stores/resources";
import { useShell } from "../stores/shell";
import { startWindowLayout, useWindowLayout } from "../stores/windowLayout";
import { AppHeader } from "./AppHeader";
import { clusterStatus } from "./clusterStatus";
import { runCommand, runMenuCommand, useCommandContext } from "./commands";
import { Hotbar } from "./Hotbar";
import { installHistoryShortcuts } from "./history";
import styles from "./Shell.module.css";
import { StatusBar } from "./StatusBar";
import { installShellKeys } from "./shellKeys";
import { IS_MAC } from "./shortcuts";
import { installHashMirror } from "./tabs/hashMirror";
import { screenLinkHandlers } from "./tabs/navigation";
import { Panes } from "./tabs/Panes";
import { isTabRoute, tabCluster } from "./tabs/routes";
import {
  ShellRouter,
  shellNavigator,
  useFocusedPath,
} from "./tabs/ShellRouter";
import { installTabKeys } from "./tabs/tabKeys";

/** The focused tab's cluster, or null on a tab without one. */
function useFocusedCluster(): string | null {
  const path = useFocusedPath();
  return path === null ? null : tabCluster(path);
}

/**
 * The cluster the sidebar shows: the focused tab's; on a tab without a cluster, the
 * one it showed before (spec P23). A cluster gone from the catalog is dropped.
 */
function useSidebarCluster(): string | null {
  const focused = useFocusedCluster();
  const [kept, setKept] = useState(focused);
  if (focused !== null && focused !== kept) setKept(focused);
  const id = focused ?? kept;
  const known = useCatalog(
    (s) => id === null || s.loading || s.clusters.some((c) => c.id === id),
  );
  return known ? id : null;
}

/** The sidebar of a cluster that is not connected: its name, state and Connect. */
function SidebarWaiting(props: { clusterId: string }) {
  const { clusterId } = props;
  const state = useClusterState(clusterId);
  const name = useCatalog(
    (s) => s.clusters.find((c) => c.id === clusterId)?.name ?? "Cluster",
  );
  const { connect, busy } = useConnect(clusterId);
  const status = clusterStatus(state);
  return (
    <div className={styles.navNote} data-testid="sidebar-waiting">
      <p className={styles.navName}>
        <StatusDot tone={status.tone} label={status.label} />
        {name}
      </p>
      <p className={styles.navText}>{`${status.label}.`}</p>
      {state.status === "connecting" ? null : (
        <Button
          data-testid="sidebar-connect"
          disabled={busy}
          onClick={() => void connect()}
        >
          Connect
        </Button>
      )}
    </div>
  );
}

function SidebarCluster(props: { clusterId: string }) {
  const connected = useClusterState(props.clusterId).status === "connected";
  return connected ? (
    <ClusterNav clusterId={props.clusterId} />
  ) : (
    <SidebarWaiting clusterId={props.clusterId} />
  );
}

/** The sidebar column, between the rail and the panes, with its resize handle (P1, P23). */
function SidebarColumn() {
  const clusterId = useSidebarCluster();
  const [navWidth, setNavWidth] = usePaneSize(NAV_PANE);
  return (
    <div className={styles.nav} style={{ width: navWidth }}>
      {clusterId === null ? (
        <div className={styles.navNote} data-testid="sidebar-empty">
          <p className={styles.navText}>
            Open a cluster to see its navigation here.
          </p>
        </div>
      ) : (
        <SidebarCluster key={clusterId} clusterId={clusterId} />
      )}
      <PaneHandle
        label="Resize navigation"
        edge="right"
        value={navWidth}
        min={NAV_PANE.min}
        max={NAV_PANE.max}
        initial={NAV_PANE.initial}
        onChange={setNavWidth}
        testId="nav-resize"
      />
    </div>
  );
}

function ConnectedDock(props: { clusterId: string }) {
  const { resources } = useApiResources(props.clusterId);
  // Ctrl/Cmd and middle clicks on links in the dock go to the focused tab's pane.
  const links = useMemo(() => screenLinkHandlers(), []);
  return (
    <div className={styles.dock} {...links}>
      <Dock clusterId={props.clusterId} resources={resources} />
    </div>
  );
}

/** This window's dock, under the panes, with the tabs of the focused tab's cluster (P37). */
function ShellDock() {
  const clusterId = useFocusedCluster();
  const state = useClusterState(clusterId ?? "");
  if (clusterId === null || state.status !== "connected") return null;
  return <ConnectedDock key={clusterId} clusterId={clusterId} />;
}

/**
 * The catalog, the history keys and mouse buttons, the shell and tab keys, and the
 * menu's commands.
 */
function ShellEffects() {
  const init = useCatalog((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  // Back and forward move the focused tab (spec P3).
  useEffect(() => installHistoryShortcuts((d) => shellNavigator.go(d)), []);

  // Mod+\, Mod+W, Ctrl+Tab and Mod+1 to Mod+3 (spec P16).
  useEffect(() => installTabKeys(IS_MAC), []);

  // The listeners are installed once and read the latest context through a ref.
  const context = useCommandContext();
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  useEffect(
    () =>
      installShellKeys(
        {
          palette: () => useShell.getState().open("palette"),
          shortcuts: () => useShell.getState().open("shortcuts"),
          preferences: () => runCommand("preferences", contextRef.current),
        },
        IS_MAC,
      ),
    [],
  );

  // The macOS menu's app items (spec C §9.2). Elsewhere nothing emits the event.
  useEffect(() => {
    const listening = events.onMenuCommand(({ id }) =>
      runMenuCommand(id, contextRef.current),
    );
    return () => {
      // A failed unlisten at unmount has nothing to undo, so it is not reported.
      void listening.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  return null;
}

/**
 * A window: the rail, the sidebar, the panes with the dock under them, the header on
 * top and the status bar at the bottom (spec P1). Each part outside the panes has a
 * router on the focused tab's location, since a tab's own router cannot sit inside one.
 */
export function Shell() {
  const ready = useWindowLayout((s) => s.ready);

  // The hash is applied to the layout loaded from the core, not to the one before it.
  useEffect(() => {
    let live = true;
    let stop = () => {};
    void startWindowLayout(isTabRoute).then(() => {
      if (live) stop = installHashMirror(isTabRoute);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  return (
    <div className={styles.shell}>
      <ShellRouter>
        <Hotbar />
      </ShellRouter>
      <div className={styles.column}>
        <ShellRouter>
          <AppHeader />
        </ShellRouter>
        <div className={styles.body}>
          <ShellRouter>
            <SidebarColumn />
          </ShellRouter>
          <div className={styles.work}>
            <main className={styles.content}>
              {ready ? (
                <Panes />
              ) : (
                <div className={styles.loading}>
                  <Spinner label="Loading" />
                </div>
              )}
            </main>
            <ShellRouter>
              <ShellDock />
            </ShellRouter>
          </div>
        </div>
      </div>
      <StatusBar />
      <ShellRouter>
        <ShellEffects />
        <CommandPalette />
        <ShortcutsDialog />
        <AboutDialog />
      </ShellRouter>
    </div>
  );
}
