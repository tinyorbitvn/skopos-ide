import { useMemo } from "react";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { NAMESPACES, NODES, PODS } from "../../kinds/refs";
import { useCatalog } from "../../stores/catalog";
import { useClusterState } from "../../stores/clusters";
import { findResource } from "../../stores/resources";
import { useTopology } from "../../stores/topology";
import { OverviewMetrics } from "../metrics/OverviewMetrics";
import { useListUsage } from "../metrics/useListUsage";
import { OverviewCell, OverviewGrid } from "../overview";
import { useOverviewDrawer } from "../sections/useOverviewDrawer";
import { CapacityCard } from "./CapacityCard";
import { ClusterCard } from "./ClusterCard";
import { useClusterContext } from "./ClusterLayout";
import styles from "./ClusterScreen.module.css";
import { HealthCard } from "./HealthCard";
import { type CapacityTotals, capacityOf } from "./overviewModel";
import { TopConsumersCard } from "./TopConsumersCard";

/** The kinds the Overview opens in its drawer, as `?open=pods` and `?open=namespaces` (R3). */
const OPENABLE: readonly ResourceRef[] = [PODS, NAMESPACES];
/** Node usage is read across the cluster. */
const NO_NAMESPACES: string[] = [];
const NO_TOTALS: CapacityTotals = { cores: null, bytes: null, pods: null };

/**
 * The content of a connected cluster: the Overview page of the sidebar (cluster overview
 * spec §3), a grid of cards with the usual drawer over it.
 */
export function ClusterHome(props: {
  clusterId: string;
  clusterName: string;
  info: ClusterInfo;
}) {
  const { clusterId, info } = props;
  const { resources, resourcesLoading, resourcesError } = useClusterContext();
  const discovery = useMemo(
    () => ({ loading: resourcesLoading, error: resourcesError }),
    [resourcesLoading, resourcesError],
  );
  const topology = useTopology(clusterId);
  const nodeUsage = useListUsage(clusterId, NODES, NO_NAMESPACES);
  const nodesInfo = findResource(resources, "", "nodes");
  // R2: discovery says the account may not list nodes.
  const nodesForbidden = nodesInfo !== undefined && !nodesInfo.canList;
  const capacity = useMemo(
    () =>
      capacityOf({
        snapshot: topology.snapshot,
        error: topology.error,
        nodesForbidden,
        usage: nodeUsage,
      }),
    [topology.snapshot, topology.error, nodesForbidden, nodeUsage],
  );
  const totals = capacity?.totals ?? NO_TOTALS;
  const allocatable = useMemo(
    () => ({ cores: totals.cores, bytes: totals.bytes }),
    [totals.cores, totals.bytes],
  );
  const drawer = useOverviewDrawer(clusterId, resources, OPENABLE);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the root only listens for the Escape that closes the drawer, as on list screens.
    <div
      className={styles.home}
      data-testid="overview-page"
      onKeyDown={drawer.onKeyDown}
    >
      <OverviewGrid testId="overview-grid">
        <OverviewCell span={5}>
          <CapacityCard capacity={capacity} />
        </OverviewCell>
        <OverviewCell span={7}>
          <HealthCard
            clusterId={clusterId}
            resources={resources}
            discovery={discovery}
            snapshot={topology.snapshot}
            topologyError={topology.error}
            nodesForbidden={nodesForbidden}
          />
        </OverviewCell>
        <OverviewCell span={4}>
          <ClusterCard clusterId={clusterId} info={info} />
        </OverviewCell>
        <OverviewCell span={8}>
          <TopConsumersCard
            clusterId={clusterId}
            totals={totals}
            nodesForbidden={nodesForbidden}
            onOpen={(plural, key) =>
              drawer.open(plural === "pods" ? PODS : NAMESPACES, key)
            }
          />
        </OverviewCell>
        <OverviewCell span={12}>
          <OverviewMetrics
            clusterId={clusterId}
            clusterName={props.clusterName}
            info={info}
            allocatable={allocatable}
          />
        </OverviewCell>
      </OverviewGrid>
      {drawer.drawer}
    </div>
  );
}

/** The index route of a connected cluster. */
export function ClusterOverview() {
  const { clusterId } = useClusterContext();
  const state = useClusterState(clusterId);
  const name = useCatalog(
    (s) => s.clusters.find((c) => c.id === clusterId)?.name ?? clusterId,
  );
  if (state.status !== "connected") return null;
  return (
    <ClusterHome clusterId={clusterId} clusterName={name} info={state.info} />
  );
}
