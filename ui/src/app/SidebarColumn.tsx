import { Button, PaneHandle, StatusDot } from "../design";
import { ClusterNav } from "../features/cluster/ClusterNav";
import { useCatalog } from "../stores/catalog";
import { useClusterState, useConnect } from "../stores/clusters";
import { NAV_PANE, usePaneSize } from "../stores/paneSize";
import { ClusterSwitcher, useSidebarCluster } from "./ClusterSwitcher";
import { clusterStatus } from "./clusterStatus";
import styles from "./SidebarColumn.module.css";

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

function SidebarCluster(props: { clusterId: string }) {
  const connected = useClusterState(props.clusterId).status === "connected";
  return connected ? (
    <ClusterNav clusterId={props.clusterId} />
  ) : (
    <SidebarWaiting clusterId={props.clusterId} />
  );
}

/**
 * The sidebar column, between the hotbar and the panes, with its resize handle: the
 * cluster switcher on top of the shown cluster's navigation (P1, P23 to P25), on one
 * glass layer (spec Q §1).
 */
export function SidebarColumn() {
  const { clusterId, focused, pick, follow } = useSidebarCluster();
  const [navWidth, setNavWidth] = usePaneSize(NAV_PANE);
  return (
    <div
      className={styles.column}
      style={{ width: navWidth }}
      data-testid="sidebar-column"
    >
      <ClusterSwitcher
        clusterId={clusterId}
        focused={focused}
        onPick={pick}
        onFollow={follow}
      />
      {clusterId === null ? (
        <div className={styles.note} data-testid="sidebar-empty">
          <p className={styles.noteText}>
            Pick a cluster above, or open one, to see its navigation here.
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
