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
import { OverviewCard, StatTile, TileRow } from "../overview";
import {
  useSectionRow,
  useSectionShared,
  useSectionView,
} from "../sections/sectionLists";
import { type Discovery, WORKLOAD_KINDS } from "../workloads/counts";
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
  // The lists' namespace choice and the lists under it, read as the section pages read them (R2).
  const shared = useSectionShared(clusterId, props.resources, props.discovery);
  const namespaces = shared[3];
  const pods = useSectionView(
    shared,
    PODS_KIND.label,
    PODS_KIND.group,
    PODS_KIND.plural,
  );
  // One call per kind, in the Workloads section's order: hooks may not loop.
  const workloads = [
    useSectionRow(shared, DEPLOYMENTS),
    useSectionRow(shared, DAEMONSETS),
    useSectionRow(shared, STATEFULSETS),
    useSectionRow(shared, REPLICASETS),
    useSectionRow(shared, JOBS),
    useSectionRow(shared, CRONJOBS),
  ];
  const events = useSectionView(shared, "Events", "", "events");
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
