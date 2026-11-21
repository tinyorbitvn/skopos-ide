import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { NAMESPACES, NODES, PODS } from "../../kinds/refs";
import { useCatalog } from "../../stores/catalog";
import { useClusterState } from "../../stores/clusters";
import { findResource } from "../../stores/resources";
import { useTopology } from "../../stores/topology";
import { DetailDrawer, isDrawerEscape } from "../details/DetailDrawer";
import { useDrawerHistory } from "../details/useDrawerHistory";
import { OverviewMetrics } from "../metrics/OverviewMetrics";
import { useListUsage } from "../metrics/useListUsage";
import { OverviewCell, OverviewGrid } from "../overview";
import { DrawerObjectActions } from "../resources/DrawerObjectActions";
import { CapacityCard } from "./CapacityCard";
import { ClusterCard } from "./ClusterCard";
import { useClusterContext } from "./ClusterLayout";
import styles from "./ClusterScreen.module.css";
import { HealthCard } from "./HealthCard";
import { type CapacityTotals, capacityOf } from "./overviewModel";
import { TopConsumersCard } from "./TopConsumersCard";

/** The kinds the Overview opens in its drawer, by `?open=`. */
const OPENABLE: Partial<Record<string, ResourceRef>> = {
  pods: PODS,
  namespaces: NAMESPACES,
};
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

  const [params, setParams] = useSearchParams();
  const open = params.get("open");
  const opened = open === null ? undefined : OPENABLE[open];
  const resource = opened ?? PODS;
  const history = useDrawerHistory(
    resource,
    opened === undefined ? null : params.get("object"),
  );
  const drawerInfo = findResource(resources, resource.group, resource.plural);
  // `setParams` changes with the location; the callback reads it here, so it stays the same.
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const openObject = useCallback((plural: string | null, key?: string) => {
    setParamsRef.current(
      (p) => {
        const next = new URLSearchParams(p);
        if (plural === null || key === undefined) {
          next.delete("open");
          next.delete("object");
        } else {
          next.set("open", plural);
          next.set("object", key);
        }
        return next;
      },
      { replace: false },
    );
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the root only listens for the Escape that closes the drawer, as on list screens.
    <div
      className={styles.home}
      data-testid="overview-page"
      onKeyDown={(e) => {
        if (!isDrawerEscape(e)) return;
        e.stopPropagation();
        openObject(null);
      }}
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
            onOpen={openObject}
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
      <DetailDrawer
        clusterId={clusterId}
        resource={resource}
        history={history}
        onClose={() => openObject(null)}
        resources={resources}
        actions={
          drawerInfo === undefined
            ? undefined
            : (object) => (
                <DrawerObjectActions
                  clusterId={clusterId}
                  info={drawerInfo}
                  object={object}
                />
              )
        }
      />
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
