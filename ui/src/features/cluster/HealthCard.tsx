import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Boxes,
  type IconComponent,
  Server,
  TriangleAlert,
} from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { TopologySnapshot } from "../../ipc/generated/TopologySnapshot";
import { findResource } from "../../stores/resources";
import { useUiState } from "../../stores/uiState";
import { OverviewCard, StatTile, TileRow } from "../overview";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import {
  type Discovery,
  type KindRow,
  kindRow,
  type ListView,
  listView,
  WORKLOAD_KINDS,
  type WorkloadKind,
} from "../workloads/counts";
import { useListIn } from "../workloads/useListIn";
import styles from "./OverviewCards.module.css";
import { healthOf, namespaceCaption, type TileId } from "./overviewModel";

const ICONS: Record<TileId, IconComponent> = {
  nodes: Server,
  pods: Box,
  workloads: Boxes,
  events: TriangleAlert,
};

const [
  PODS_KIND,
  DEPLOYMENTS,
  DAEMONSETS,
  STATEFULSETS,
  REPLICASETS,
  JOBS,
  CRONJOBS,
] = WORKLOAD_KINDS;

type Shared = readonly [
  clusterId: string,
  resources: ApiResourceInfo[],
  discovery: Discovery,
  namespaces: string[],
  ready: boolean,
];

/** A list as the overview reads it, under the chosen namespaces. */
function useView(
  shared: Shared,
  label: string,
  group: string,
  plural: string,
): ListView {
  const [clusterId, resources, discovery, namespaces, ready] = shared;
  const info = findResource(resources, group, plural);
  const list = useListIn(clusterId, info, namespaces, ready);
  return useMemo(
    () => listView(label, info, discovery, list, namespaces),
    [label, info, discovery, list, namespaces],
  );
}

/** A workload kind's row, counted as the Workloads overview counts it. */
function useRow(shared: Shared, kind: WorkloadKind): KindRow {
  const [clusterId, resources, discovery, namespaces, ready] = shared;
  const info = findResource(resources, kind.group, kind.plural);
  const list = useListIn(clusterId, info, namespaces, ready);
  return useMemo(
    () => kindRow(kind, info, discovery, list, namespaces),
    [kind, info, discovery, list, namespaces],
  );
}

/** A clock that moves once a minute, so Warning events age out of the last hour (spec §5). */
function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  return tick;
}

/** The Health card (spec §3.3): four tiles that open their lists. */
export function HealthCard(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  discovery: Discovery;
  snapshot: TopologySnapshot | null;
  topologyError: string | null;
  nodesForbidden: boolean;
}) {
  const { clusterId } = props;
  const [namespaces, , namespacesRead] = useUiState<string[]>(
    namespaceFilterKey(clusterId),
    [],
  );
  const shared: Shared = [
    clusterId,
    props.resources,
    props.discovery,
    namespaces,
    namespacesRead,
  ];
  const pods = useView(
    shared,
    PODS_KIND.label,
    PODS_KIND.group,
    PODS_KIND.plural,
  );
  // One call per kind, in the Workloads section's order: hooks may not loop.
  const workloads = [
    useRow(shared, DEPLOYMENTS),
    useRow(shared, DAEMONSETS),
    useRow(shared, STATEFULSETS),
    useRow(shared, REPLICASETS),
    useRow(shared, JOBS),
    useRow(shared, CRONJOBS),
  ];
  const events = useView(shared, "Events", "", "events");
  const tick = useMinuteTick();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the clock is read again each minute and whenever the events change.
  const nowMs = useMemo(() => Date.now(), [tick, events]);
  const tiles = healthOf({
    clusterId,
    snapshot: props.snapshot,
    topologyError: props.topologyError,
    nodesForbidden: props.nodesForbidden,
    pods,
    workloads,
    events,
    nowMs,
  });
  const caption = namespaceCaption(namespaces);
  return (
    <OverviewCard title="Health" testId="overview-health">
      <TileRow>
        {tiles.map((tile) => (
          <StatTile key={tile.id} {...tile} icon={ICONS[tile.id]} />
        ))}
      </TileRow>
      {caption ? (
        <p
          className={styles.caption}
          title={caption.title}
          data-testid="overview-health-namespaces"
        >
          {caption.text}
        </p>
      ) : null}
    </OverviewCard>
  );
}
