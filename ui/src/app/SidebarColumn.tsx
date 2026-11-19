import type { ReactNode } from "react";
import { Button, PaneHandle, StatusDot, Tooltip } from "../design";
import { ChevronLeft, ChevronRight, Plug } from "../design/icons";
import { ClusterNav } from "../features/cluster/ClusterNav";
import { useCatalog } from "../stores/catalog";
import { useClusterState, useConnect } from "../stores/clusters";
import { NAV_PANE, usePaneSize } from "../stores/paneSize";
import { useSidebarCollapse } from "../stores/sidebarCollapse";
import { ClusterSwitcher, useSidebarCluster } from "./ClusterSwitcher";
import { clusterStatus } from "./clusterStatus";
import styles from "./SidebarColumn.module.css";
import { IS_MAC, shortKeys } from "./shortcuts";

/** The collapsed column's width (spec Q §3). */
const RAIL_WIDTH = 64;

function useClusterName(clusterId: string): string {
  return useCatalog(
    (s) => s.clusters.find((c) => c.id === clusterId)?.name ?? "Cluster",
  );
}

/** The sidebar of a cluster that is not connected: its name, state and Connect. */
function SidebarWaiting(props: { clusterId: string }) {
  const { clusterId } = props;
  const state = useClusterState(clusterId);
  const name = useClusterName(clusterId);
  const { connect, busy } = useConnect(clusterId);
  const status = clusterStatus(state);
  return (
    <div className={styles.note} data-testid="sidebar-waiting">
      <p className={styles.noteName}>
        <StatusDot tone={status.tone} label={status.label} />
        {name}
      </p>
      <p className={styles.noteText}>{`${status.label}.`}</p>
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

/** Collapsed and not connected: a single rail icon that connects (spec Q §3). */
function SidebarConnectIcon(props: { clusterId: string }) {
  const { clusterId } = props;
  const state = useClusterState(clusterId);
  const name = useClusterName(clusterId);
  const { connect, busy } = useConnect(clusterId);
  const label = `Connect ${name}`;
  return (
    <nav
      className={styles.rail}
      aria-label="Cluster navigation"
      data-testid="sidebar-waiting"
    >
      <Tooltip content={label} side="right">
        <button
          type="button"
          className={styles.railIcon}
          aria-label={label}
          data-testid="sidebar-connect"
          disabled={busy || state.status === "connecting"}
          onClick={() => void connect()}
        >
          <Plug size={18} />
        </button>
      </Tooltip>
    </nav>
  );
}

function SidebarCluster(props: { clusterId: string; collapsed: boolean }) {
  const { clusterId, collapsed } = props;
  const connected = useClusterState(clusterId).status === "connected";
  if (connected)
    return <ClusterNav clusterId={clusterId} collapsed={collapsed} />;
  if (collapsed) return <SidebarConnectIcon clusterId={clusterId} />;
  return <SidebarWaiting clusterId={clusterId} />;
}

/** What sits under the switcher. Collapsed without a cluster, nothing: there is none to name. */
function columnBody(clusterId: string | null, collapsed: boolean): ReactNode {
  if (clusterId !== null) {
    return (
      <SidebarCluster
        key={clusterId}
        clusterId={clusterId}
        collapsed={collapsed}
      />
    );
  }
  if (collapsed) return null;
  return (
    <div className={styles.note} data-testid="sidebar-empty">
      <p className={styles.noteText}>
        Pick a cluster above, or open one, to see its navigation here.
      </p>
    </div>
  );
}

/**
 * The sidebar column, between the hotbar and the panes: the cluster switcher on top of
 * the shown cluster's navigation (P1, P23 to P25), on one glass layer (spec Q §1). It
 * collapses to a 64 px icon rail, per window (spec Q §3).
 */
export function SidebarColumn() {
  const { clusterId, focused, pick, follow } = useSidebarCluster();
  const [navWidth, setNavWidth] = usePaneSize(NAV_PANE);
  const [collapsed, toggle] = useSidebarCollapse();
  const keys = shortKeys("toggleSidebar", IS_MAC);
  return (
    <div
      className={styles.column}
      style={{ width: collapsed ? RAIL_WIDTH : navWidth }}
      data-collapsed={collapsed ? "true" : undefined}
      data-testid="sidebar-column"
    >
      <ClusterSwitcher
        clusterId={clusterId}
        focused={focused}
        onPick={pick}
        onFollow={follow}
        collapsed={collapsed}
      />
      {columnBody(clusterId, collapsed)}
      {collapsed ? null : (
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
      )}
      <button
        type="button"
        className={styles.collapse}
        aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
        title={
          collapsed
            ? `Expand the sidebar (${keys})`
            : `Collapse the sidebar to icons (${keys})`
        }
        data-testid="sidebar-collapse"
        onClick={toggle}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
    </div>
  );
}
