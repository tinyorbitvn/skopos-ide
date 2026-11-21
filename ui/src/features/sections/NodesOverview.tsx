import { useMemo, useState } from "react";
import { EmptyState, Segmented, Spinner } from "../../design";
import { MapIcon } from "../../design/icons";
import type { TopologySnapshot } from "../../ipc/generated/TopologySnapshot";
import { NODES } from "../../kinds/refs";
import type { UsageView } from "../../kinds/usageColumns";
import { useClusterState } from "../../stores/clusters";
import { useMetrics } from "../../stores/metrics";
import { useTopology } from "../../stores/topology";
import { CapacityCard } from "../cluster/CapacityCard";
import { useClusterContext } from "../cluster/ClusterLayout";
import { capacityOf } from "../cluster/overviewModel";
import { useListUsage } from "../metrics/useListUsage";
import {
  OverviewCard,
  OverviewCell,
  OverviewGrid,
  type TopRow,
  TopTable,
} from "../overview";
import { OverviewPage } from "../overview/OverviewPage";
import {
  type OverviewCellValue,
  type OverviewColumn,
  type OverviewRow,
  OverviewTable,
  type OverviewTableProps,
} from "../overview/OverviewTable";
import { sourceNote, usageServed } from "../topology/model";
import { topologyPath } from "../topology/paths";
import type { ListView } from "../workloads/counts";
import {
  busiestNodes,
  type DonutValue,
  donutCaption,
  loadingStateTiles,
  type NodesBy,
  nodeStateTiles,
  nodesError,
  versionTables,
  zoneRows,
} from "./nodesModel";
import styles from "./Sections.module.css";
import { useSectionShared, useSectionView } from "./sectionLists";
import { countOf, formatCount } from "./text";
import { TileGrid } from "./tiles";
import { useOverviewDrawer } from "./useOverviewDrawer";

/** Nodes are cluster-scoped: no namespaces note, and usage across the cluster (spec §3.1). */
const NO_NAMESPACES: string[] = [];
/** The kinds the drawer opens on this page (spec §3.3). */
const OPENABLE = [NODES];

const BY: { value: NodesBy; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
];

/** The Busiest nodes choice by cluster, for the app's run (spec §3.3). */
const choices = new Map<string, NodesBy>();

export function resetNodesOverviewForTest(): void {
  choices.clear();
}

type Empty = OverviewTableProps["empty"];

const NO_NODES: Empty = {
  icon: MapIcon,
  title: "This cluster has no nodes",
  text: "Nodes appear here once the cluster lists them.",
};

/** A zone row's donut, with its caption beside it. */
function donutCell(value: DonutValue): OverviewCellValue {
  return { donut: { ...value, caption: donutCaption(value) } };
}

/** Why a card has nothing to show (spec §7). */
function Problem(props: { text: string }) {
  return <p className={styles.problem}>{props.text}</p>;
}

/** Busiest nodes (spec §3.3): the nodes using the most of their own CPU or memory. */
function BusiestCard(props: {
  clusterId: string;
  snapshot: TopologySnapshot | null;
  problem: string | null;
  usage: UsageView | undefined;
  onOpen(name: string): void;
}) {
  const { clusterId, snapshot, problem, usage, onOpen } = props;
  const [by, setByState] = useState<NodesBy>(
    () => choices.get(clusterId) ?? "cpu",
  );
  const setBy = (next: NodesBy) => {
    choices.set(clusterId, next);
    setByState(next);
  };
  const rows = useMemo(
    () => (snapshot === null ? [] : busiestNodes(snapshot, usage, by)),
    [snapshot, usage, by],
  );

  const provider = useMetrics((s) => s.providers[clusterId]);
  const kind = provider?.value?.kind;
  const reading =
    provider === undefined || (kind === undefined && provider.loading);
  const empty =
    kind === "none"
      ? {
          title: "Busiest nodes need metrics-server",
          body: "No metrics source is set for this cluster (metrics-server or Prometheus), so usage by node is unknown.",
        }
      : reading
        ? {
            title: "Reading usage",
            body: "Checking where this cluster reports usage.",
          }
        : usage?.notServed
          ? {
              title: "Busiest nodes need metrics-server",
              body: "This cluster does not serve the metrics API (metrics.k8s.io), so usage by node is unknown.",
            }
          : null;
  const showTable = problem === null && empty === null && snapshot !== null;
  const cpu = by === "cpu";

  return (
    <OverviewCard
      title="Busiest nodes"
      testId="nodes-overview-card-busiest"
      tools={
        showTable ? (
          <Segmented
            label="Busiest nodes by"
            size="sm"
            value={by}
            options={BY}
            onChange={setBy}
            testId="nodes-busiest-by"
          />
        ) : null
      }
    >
      {problem !== null ? (
        <Problem text={problem} />
      ) : empty !== null ? (
        <EmptyState title={empty.title} body={empty.body} />
      ) : snapshot === null ? (
        <Spinner label="Loading nodes" />
      ) : (
        <TopTable
          id="nodes-busiest"
          title={cpu ? "By CPU usage" : "By memory usage"}
          nameHead="Node"
          valueHead={cpu ? "CPU" : "Memory"}
          shareHead="Usage"
          total={null}
          what={cpu ? "CPU" : "memory"}
          rows={rows.map(
            (row): TopRow => ({ ...row, onOpen: () => onOpen(row.name) }),
          )}
        />
      )}
    </OverviewCard>
  );
}

/** By zone (spec §3.3): each zone's nodes and their usage of its allocatable. */
function ZonesCard(props: {
  clusterId: string;
  snapshot: TopologySnapshot | null;
  problem: string | null;
  usage: UsageView | undefined;
}) {
  const { clusterId, snapshot, problem, usage } = props;
  const served = usageServed(usage);
  const requests = served ? "" : " requests";
  const columns: OverviewColumn[] = [
    { head: "Zone", width: "minmax(84px, 1fr)" },
    { head: "Nodes", width: "52px", align: "end" },
    { head: `CPU${requests}`, width: "minmax(0, 1.3fr)" },
    { head: `Memory${requests}`, width: "minmax(0, 1.3fr)" },
    { head: "Pods", width: "minmax(0, 1.3fr)" },
  ];
  const zones = useMemo(
    () => (snapshot === null ? [] : zoneRows(snapshot, usage)),
    [snapshot, usage],
  );
  // R6: every zone opens the Node topology page, without a zone filter.
  const to = topologyPath(clusterId);
  const rows = zones.map(
    (zone): OverviewRow => ({
      key: `${zone.region}/${zone.zone}`,
      name: zone.zone,
      sub: zone.region,
      to,
      cells: [
        { text: formatCount(zone.nodes) },
        donutCell(zone.cpu),
        donutCell(zone.memory),
        donutCell(zone.pods),
      ],
    }),
  );
  return (
    <OverviewCard title="By zone" testId="nodes-overview-card-zones">
      {problem !== null ? (
        <Problem text={problem} />
      ) : (
        <>
          <OverviewTable
            id="nodes-zones"
            label="Nodes by zone"
            columns={columns}
            rows={rows}
            minWidth={420}
            loading={snapshot === null}
            empty={NO_NODES}
          />
          {rows.length > 0 ? (
            <p className={styles.caption} data-testid="nodes-zones-caption">
              {sourceNote(served)}
            </p>
          ) : null}
        </>
      )}
    </OverviewCard>
  );
}

function versionColumns(head: string): OverviewColumn[] {
  return [
    { head, width: "minmax(0, 1fr)" },
    { head: "Nodes", width: "80px", align: "end" },
  ];
}

/** Versions (spec §3.3, R7): three tables side by side, from the Nodes list. */
function VersionsCard(props: { view: ListView; apiServer: string }) {
  const { view, apiServer } = props;
  const tables = useMemo(
    () => versionTables(view.state === "ready" ? view.items : [], apiServer),
    [view, apiServer],
  );
  return (
    <OverviewCard title="Versions" testId="nodes-overview-card-versions">
      {view.state === "unavailable" ? (
        <Problem text={nodesError(view.reason)} />
      ) : (
        <div className={styles.sideBySide}>
          {tables.map((table) => (
            <OverviewTable
              key={table.id}
              id={`nodes-${table.id}`}
              title={table.title}
              label={table.title}
              columns={versionColumns(table.head)}
              rows={table.rows.map(
                (row): OverviewRow => ({
                  key: row.value,
                  name: row.value,
                  sub: row.sub,
                  cells: [{ text: countOf(row.nodes, "node") }],
                }),
              )}
              loading={view.state === "loading"}
              empty={NO_NODES}
            />
          ))}
        </div>
      )}
    </OverviewCard>
  );
}

/**
 * The Nodes overview (section overviews spec §3.3): Capacity, the nodes by state, the busiest
 * nodes, the zones and the versions, with the Node drawer over the page. Without the right to
 * list nodes it shows one empty state and watches nothing.
 */
export function NodesOverview() {
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const discovery = useMemo(
    () => ({ loading: resourcesLoading, error: resourcesError }),
    [resourcesLoading, resourcesError],
  );
  const shared = useSectionShared(clusterId, resources, discovery);
  const nodes = useSectionView(shared, "Nodes", "", "nodes");
  // Discovery's `canList`, or the API server's answer (R1).
  const forbidden =
    nodes.state === "unavailable" && nodes.cause === "forbidden";
  const topology = useTopology(forbidden ? null : clusterId);
  const usage = useListUsage(
    clusterId,
    forbidden ? null : NODES,
    NO_NAMESPACES,
  );
  const state = useClusterState(clusterId);
  const apiServer = state.status === "connected" ? state.info.version : "";

  const capacity = useMemo(
    () =>
      capacityOf({
        snapshot: topology.snapshot,
        error: topology.error,
        nodesForbidden: forbidden,
        usage,
      }),
    [topology.snapshot, topology.error, forbidden, usage],
  );
  const stateTiles = useMemo(
    () =>
      topology.snapshot === null
        ? loadingStateTiles(clusterId)
        : nodeStateTiles(topology.snapshot, clusterId),
    [topology.snapshot, clusterId],
  );
  // A failure keeps the last snapshot; only a failure before the first one leaves no nodes.
  const problem =
    topology.snapshot === null && topology.error !== null
      ? nodesError(topology.error)
      : null;
  const drawer = useOverviewDrawer(clusterId, resources, OPENABLE);

  if (forbidden) {
    return (
      <OverviewPage
        title="Nodes overview"
        testId="nodes-overview"
        namespaces={NO_NAMESPACES}
      >
        <div data-testid="nodes-overview-denied">
          <EmptyState
            title="You may not list nodes"
            body="The nodes API is forbidden for your account, so their state, zones and versions are unknown."
          />
        </div>
      </OverviewPage>
    );
  }

  return (
    <OverviewPage
      title="Nodes overview"
      testId="nodes-overview"
      namespaces={NO_NAMESPACES}
      onKeyDown={drawer.onKeyDown}
    >
      <OverviewGrid>
        <OverviewCell span={5}>
          <CapacityCard
            capacity={capacity}
            testId="nodes-overview-card-capacity"
          />
        </OverviewCell>
        <OverviewCell span={7}>
          <OverviewCard
            title="Nodes by state"
            testId="nodes-overview-card-state"
          >
            {problem !== null ? (
              <Problem text={problem} />
            ) : (
              <TileGrid tiles={stateTiles} />
            )}
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={5}>
          <BusiestCard
            clusterId={clusterId}
            snapshot={topology.snapshot}
            problem={problem}
            usage={usage}
            onOpen={(name) => drawer.open(NODES, `/${name}`)}
          />
        </OverviewCell>
        <OverviewCell span={7}>
          <ZonesCard
            clusterId={clusterId}
            snapshot={topology.snapshot}
            problem={problem}
            usage={usage}
          />
        </OverviewCell>
        <OverviewCell span={12}>
          <VersionsCard view={nodes} apiServer={apiServer} />
        </OverviewCell>
      </OverviewGrid>
      {drawer.drawer}
    </OverviewPage>
  );
}
