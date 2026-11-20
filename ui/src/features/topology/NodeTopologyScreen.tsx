import { type ReactNode, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { Button, EmptyState, Spinner } from "../../design";
import { TriangleAlert } from "../../design/icons";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { NODES, PODS } from "../../kinds/refs";
import { useCatalog } from "../../stores/catalog";
import { findResource } from "../../stores/resources";
import { useTopology } from "../../stores/topology";
import { useClusterContext } from "../cluster/ClusterLayout";
import { DetailDrawer, isDrawerEscape } from "../details/DetailDrawer";
import { useDrawerHistory } from "../details/useDrawerHistory";
import { useListUsage } from "../metrics/useListUsage";
import { DrawerObjectActions } from "../resources/DrawerObjectActions";
import { ClusterBox } from "./ClusterBox";
import { GroupBox } from "./GroupBox";
import {
  clusterLabel,
  countText,
  filterRegions,
  mapNamespaces,
  nodeTotal,
  regionLabel,
  sourceNote,
  usageServed,
  zoneLabel,
} from "./model";
import { NodeCard } from "./NodeCard";
import styles from "./Topology.module.css";
import { TopologyToolbar } from "./TopologyToolbar";

/** The kinds the page opens in its drawer, by `?open=`. */
const OPENABLE: Partial<Record<string, ResourceRef>> = {
  pods: PODS,
  nodes: NODES,
};
/** Node usage is read across the cluster. */
const NO_NAMESPACES: string[] = [];
const SKELETONS = [1, 2, 3, 4, 5, 6];

function TopologyLoading() {
  return (
    <div data-testid="topology-loading">
      <Spinner label="Loading nodes…" />
      <div className={styles.skeletons}>
        {SKELETONS.map((n) => (
          <div
            key={n}
            className={styles.skeleton}
            data-testid="topology-skeleton"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * `cluster/:id/node-topology` (topology spec §3): the cluster's nodes in a cluster box, by
 * region and zone, with the usual drawer over them. The filter (`?q=`) and the highlight
 * (`?ns=`) live in the tab's URL and replace its entry; opening an object pushes one, as on
 * list screens.
 */
export function NodeTopologyScreen() {
  const { clusterId, resources } = useClusterContext();
  // The cluster switcher's source for the name, distribution and version.
  const cluster = useCatalog((s) => s.clusters.find((c) => c.id === clusterId));
  const topology = useTopology(clusterId);
  const usage = useListUsage(clusterId, NODES, NO_NAMESPACES);
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const highlight = params.get("ns");
  const open = params.get("open");
  const opened = open === null ? undefined : OPENABLE[open];
  const resource = opened ?? PODS;
  const history = useDrawerHistory(
    resource,
    opened === undefined ? null : params.get("object"),
  );
  const info = findResource(resources, resource.group, resource.plural);

  // `setParams` changes with the location; the callbacks read it here, so they stay the
  // same and the memoized cards do not redraw.
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const update = useCallback((name: "q" | "ns", value: string | null) => {
    setParamsRef.current(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === null || value === "") next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  }, []);
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
  const onOpenNode = useCallback(
    (name: string) => openObject("nodes", `/${name}`),
    [openObject],
  );
  const onQuery = useCallback((q: string) => update("q", q), [update]);
  const onHighlight = useCallback(
    (namespace: string | null) => update("ns", namespace),
    [update],
  );

  const { snapshot } = topology;
  const regions = useMemo(
    () => (snapshot === null ? [] : filterRegions(snapshot.regions, query)),
    [snapshot, query],
  );
  const namespaces = useMemo(
    () => (snapshot === null ? [] : mapNamespaces(snapshot)),
    [snapshot],
  );
  const served = usageServed(usage);
  const usageItems = served ? (usage?.items ?? null) : null;

  let body: ReactNode = null;
  if (snapshot === null) {
    if (topology.loading) body = <TopologyLoading />;
  } else if (snapshot.nodeCount === 0) {
    body = <EmptyState title="This cluster has no nodes" />;
  } else if (regions.length === 0) {
    body = (
      <EmptyState
        title="No node matches the filter"
        action={
          <Button
            data-testid="topology-clear-filter"
            onClick={() => update("q", null)}
          >
            Clear filter
          </Button>
        }
      />
    );
  } else {
    body = (
      <ClusterBox
        label={clusterLabel(cluster?.name ?? clusterId, cluster?.state)}
      >
        {regions.map((region) => (
          <GroupBox
            key={region.name ?? ""}
            kind="region"
            label={regionLabel(region, snapshot.podsHidden)}
            muted={region.name === null}
            testId={`topology-region-${region.name ?? "none"}`}
          >
            {region.zones.map((zone) => (
              <GroupBox
                key={zone.name ?? ""}
                kind="zone"
                label={zoneLabel(zone)}
                muted={zone.name === null}
                testId={`topology-zone-${zone.name ?? "none"}`}
              >
                {zone.nodes.map((node) => (
                  <NodeCard
                    key={node.name}
                    node={node}
                    usage={usageItems?.get(node.name)}
                    podsHidden={snapshot.podsHidden}
                    onOpen={onOpenNode}
                  />
                ))}
              </GroupBox>
            ))}
          </GroupBox>
        ))}
      </ClusterBox>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the root only listens for the Escape that closes the drawer, as on list screens.
    <div
      className={styles.screen}
      data-testid="topology-page"
      onKeyDown={(e) => {
        if (!isDrawerEscape(e)) return;
        e.stopPropagation();
        openObject(null);
      }}
    >
      <TopologyToolbar
        count={
          snapshot === null
            ? null
            : countText(
                nodeTotal(regions),
                snapshot.nodeCount,
                query.trim() !== "",
              )
        }
        query={query}
        onQuery={onQuery}
        namespaces={namespaces}
        highlight={highlight}
        onHighlight={onHighlight}
        note={sourceNote(served)}
      />
      {topology.error === null ? null : (
        <div className={styles.error} role="alert" data-testid="topology-error">
          <TriangleAlert size={16} aria-hidden="true" />
          <span className={styles.errorText}>{topology.error}</span>
          <Button
            size="sm"
            data-testid="topology-retry"
            onClick={topology.retry}
          >
            Retry
          </Button>
        </div>
      )}
      {snapshot?.podsHidden ? (
        <p className={styles.notice} data-testid="topology-pods-hidden">
          Pods are hidden: listing pods is not allowed
        </p>
      ) : null}
      <div className={styles.body}>{body}</div>
      <DetailDrawer
        clusterId={clusterId}
        resource={resource}
        history={history}
        onClose={() => openObject(null)}
        resources={resources}
        actions={
          info === undefined
            ? undefined
            : (object) => (
                <DrawerObjectActions
                  clusterId={clusterId}
                  info={info}
                  object={object}
                />
              )
        }
      />
    </div>
  );
}
