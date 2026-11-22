import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState, Spinner } from "../design";
import { AboutDialog } from "../features/about/AboutDialog";
import { ExecConsentDialog } from "../features/cluster/ExecConsentDialog";
import { Dock } from "../features/dock/Dock";
import { CommandPalette } from "../features/palette/CommandPalette";
import { ShortcutsDialog } from "../features/shortcuts/ShortcutsDialog";
import { UpdateDialog } from "../features/updates/UpdateDialog";
import { initUpdates } from "../features/updates/updateStore";
import { events } from "../ipc/events";
import { useCatalog } from "../stores/catalog";
import { useClusterState } from "../stores/clusters";
import { useDiscovery } from "../stores/discovery";
import { useFolders } from "../stores/folders";
import { useShell } from "../stores/shell";
import { toggleSidebar } from "../stores/sidebarCollapse";
import { startWindowLayout, useWindowLayout } from "../stores/windowLayout";
import { AppHeader } from "./AppHeader";
import { runCommand, runMenuCommand, useCommandContext } from "./commands";
import { Hotbar } from "./Hotbar";
import { installHistoryShortcuts } from "./history";
import styles from "./Shell.module.css";
import { SidebarColumn } from "./SidebarColumn";
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

function ConnectedDock(props: { clusterId: string }) {
  const { resources } = useDiscovery(props.clusterId);
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
  const initFolders = useFolders((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  // The switcher, the Catalog and the palette show the folder tree (P24, P29, P30).
  useEffect(() => {
    void initFolders();
  }, [initFolders]);

  // The update state, and the toast that announces a release (in-app update spec §5.3).
  useEffect(() => {
    void initUpdates();
  }, []);

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
          sidebar: toggleSidebar,
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
  const failure = useWindowLayout((s) => s.failure);
  const [attempt, setAttempt] = useState(0);

  // The hash is applied to the layout loaded from the core, not to the one before it.
  // A failed start is kept in the store and shown below; nothing is saved meanwhile.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` starts again on Try again.
  useEffect(() => {
    let live = true;
    let stop = () => {};
    void startWindowLayout(isTabRoute).then(
      () => {
        if (live) stop = installHashMirror(isTabRoute);
      },
      () => {},
    );
    return () => {
      live = false;
      stop();
    };
  }, [attempt]);

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
              ) : failure !== null ? (
                <div
                  className={styles.loading}
                  data-testid="window-load-failed"
                >
                  <EmptyState
                    title="Could not load this window's tabs."
                    body={failure}
                    action={
                      <Button onClick={() => setAttempt((n) => n + 1)}>
                        Try again
                      </Button>
                    }
                  />
                </div>
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
        <UpdateDialog />
        <ExecConsentDialog />
      </ShellRouter>
    </div>
  );
}
