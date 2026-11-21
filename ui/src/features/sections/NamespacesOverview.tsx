import { useMemo, useState } from "react";
import { EmptyState, Segmented } from "../../design";
import { Namespace, SlidersHorizontal } from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { NAMESPACES, PODS, RESOURCE_QUOTAS } from "../../kinds/refs";
import { useClusterState } from "../../stores/clusters";
import { useMetrics } from "../../stores/metrics";
import { findResource } from "../../stores/resources";
import { useTopology } from "../../stores/topology";
import { useClusterContext } from "../cluster/ClusterLayout";
import { capacityOf, type TopBy, topConsumers } from "../cluster/overviewModel";
import { useListUsage } from "../metrics/useListUsage";
import {
  OverviewCard,
  OverviewCell,
  type OverviewCellValue,
  type OverviewColumn,
  OverviewGrid,
  OverviewPage,
  type OverviewRow,
  OverviewTable,
  type TopRow,
  TopTable,
} from "../overview";
import type { ListView } from "../workloads/counts";
import {
  donutCell,
  namespacePhase,
  namespaceTiles,
  PER_NAMESPACE_KINDS,
  perNamespaceRows,
  QUOTA_HEADS,
  quotaEmpty,
  quotaRows,
  topNamespacesEmpty,
  unavailableState,
} from "./namespacesModel";
import { useSectionShared, useSectionView } from "./sectionLists";
import { formatCount, objectKey } from "./text";
import { TileGrid } from "./tiles";
import { useOverviewDrawer } from "./useOverviewDrawer";

/** The kinds the page opens in its drawer (spec §3.4). */
const OPENABLE: readonly ResourceRef[] = [NAMESPACES, RESOURCE_QUOTAS];
/** Pod usage is ranked across the cluster, as spec 1's Top namespaces ranks it. */
const NO_NAMESPACES: string[] = [];
const DASH = "—";

const BY: { value: TopBy; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
];

/** The Top namespaces choice by cluster, for the app's run, apart from the cluster Overview's. */
const choices = new Map<string, TopBy>();

export function resetNamespacesOverviewForTest(): void {
  choices.clear();
}

const QUOTA_COLUMNS: OverviewColumn[] = [
  { head: "ResourceQuota", width: "minmax(96px, 1fr)" },
  ...QUOTA_HEADS.map(
    (head): OverviewColumn => ({ head, width: "minmax(0, 1.2fr)" }),
  ),
];

const PER_NAMESPACE_COLUMNS: OverviewColumn[] = [
  { head: "Namespace", width: "minmax(110px, 1fr)" },
  ...PER_NAMESPACE_KINDS.map(
    (k): OverviewColumn => ({ head: k.label, width: "64px", align: "end" }),
  ),
];

const [
  POD_KIND,
  DEPLOYMENT_KIND,
  STATEFUL_SET_KIND,
  DAEMON_SET_KIND,
  JOB_KIND,
  CRON_JOB_KIND,
] = PER_NAMESPACE_KINDS;

const reasonOf = (view: ListView): string | undefined =>
  view.state === "unavailable" ? view.reason : undefined;

/**
 * Top namespaces (spec §3.4): spec 1's table of the namespaces that use the most, as shares
 * of the cluster's allocatable, under a CPU / Memory switch of its own.
 */
function TopNamespacesCard(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  onOpen(key: string): void;
}) {
  const { clusterId, onOpen } = props;
  const [by, setByState] = useState<TopBy>(
    () => choices.get(clusterId) ?? "cpu",
  );
  const setBy = (next: TopBy) => {
    choices.set(clusterId, next);
    setByState(next);
  };
  const topology = useTopology(clusterId);
  const nodesInfo = findResource(props.resources, "", "nodes");
  const nodesForbidden = nodesInfo !== undefined && !nodesInfo.canList;
  // Only the allocatable is read, and it needs no usage.
  const totals = useMemo(
    () =>
      capacityOf({
        snapshot: topology.snapshot,
        error: topology.error,
        nodesForbidden,
        usage: undefined,
      })?.totals ?? null,
    [topology.snapshot, topology.error, nodesForbidden],
  );
  const usage = useListUsage(clusterId, PODS, NO_NAMESPACES);
  const top = useMemo(() => topConsumers(usage, by).namespaces, [usage, by]);

  const provider = useMetrics((s) => s.providers[clusterId]);
  const kind = provider?.value?.kind;
  const empty = topNamespacesEmpty({
    metricsOff: kind === "none",
    reading: provider === undefined || (kind === undefined && provider.loading),
    notServed: usage?.notServed === true,
    nodesForbidden,
  });

  const cpu = by === "cpu";
  const rows = top.map(
    ({ openKey, ...entry }): TopRow => ({
      ...entry,
      onOpen: () => onOpen(openKey),
    }),
  );
  return (
    <OverviewCard
      title="Top namespaces"
      testId="namespaces-overview-card-top"
      tools={
        empty ? null : (
          <Segmented
            label="Top namespaces by"
            size="sm"
            value={by}
            options={BY}
            onChange={setBy}
            testId="namespaces-top-by"
          />
        )
      }
    >
      {empty ? (
        <div data-testid="namespaces-top-empty">
          <EmptyState title={empty.title} body={empty.text} />
        </div>
      ) : (
        <TopTable
          id="namespaces-top"
          title={cpu ? "By CPU usage" : "By memory usage"}
          nameHead="Namespace"
          valueHead={cpu ? "CPU" : "Memory"}
          total={totals === null ? null : cpu ? totals.cores : totals.bytes}
          what={cpu ? "CPU" : "memory"}
          rows={rows}
        />
      )}
    </OverviewCard>
  );
}

/**
 * The Namespaces overview (spec §3.4): Top namespaces, the Summary tiles, Quota usage and
 * Pods and workloads per namespace, under the lists' namespace selection.
 */
export function NamespacesOverview() {
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const discovery = useMemo(
    () => ({ loading: resourcesLoading, error: resourcesError }),
    [resourcesLoading, resourcesError],
  );
  const shared = useSectionShared(clusterId, resources, discovery);
  const chosen = shared[3];
  const namespaces = useSectionView(shared, "Namespaces", "", "namespaces");
  const quotas = useSectionView(shared, "ResourceQuotas", "", "resourcequotas");
  const limits = useSectionView(shared, "LimitRanges", "", "limitranges");
  // One call per counted kind, in the columns' order: hooks may not loop (R2).
  const pods = useSectionView(
    shared,
    POD_KIND.label,
    POD_KIND.group,
    POD_KIND.plural,
  );
  const deployments = useSectionView(
    shared,
    DEPLOYMENT_KIND.label,
    DEPLOYMENT_KIND.group,
    DEPLOYMENT_KIND.plural,
  );
  const statefulSets = useSectionView(
    shared,
    STATEFUL_SET_KIND.label,
    STATEFUL_SET_KIND.group,
    STATEFUL_SET_KIND.plural,
  );
  const daemonSets = useSectionView(
    shared,
    DAEMON_SET_KIND.label,
    DAEMON_SET_KIND.group,
    DAEMON_SET_KIND.plural,
  );
  const jobs = useSectionView(
    shared,
    JOB_KIND.label,
    JOB_KIND.group,
    JOB_KIND.plural,
  );
  const cronJobs = useSectionView(
    shared,
    CRON_JOB_KIND.label,
    CRON_JOB_KIND.group,
    CRON_JOB_KIND.plural,
  );
  const drawer = useOverviewDrawer(clusterId, resources, OPENABLE);
  const cluster = useClusterState(clusterId);

  const tiles = useMemo(
    () => namespaceTiles({ clusterId, namespaces, quotas, limits }),
    [clusterId, namespaces, quotas, limits],
  );
  const quotaList = useMemo(
    () => (quotas.state === "ready" ? quotaRows(quotas.items) : []),
    [quotas],
  );
  const kinds = useMemo(
    () => [pods, deployments, statefulSets, daemonSets, jobs, cronJobs],
    [pods, deployments, statefulSets, daemonSets, jobs, cronJobs],
  );
  const perNamespace = useMemo(
    () =>
      namespaces.state === "ready"
        ? perNamespaceRows(
            namespaces.items,
            chosen,
            PER_NAMESPACE_KINDS.map((k, i) => ({
              plural: k.plural,
              view: kinds[i],
            })),
          )
        : [],
    [namespaces, chosen, kinds],
  );

  if (namespaces.state === "unavailable" && namespaces.cause === "forbidden") {
    const used = cluster.status === "connected" ? cluster.info.namespaces : [];
    return (
      <OverviewPage
        title="Namespaces overview"
        testId="namespaces-overview"
        namespaces={chosen}
      >
        <div data-testid="namespaces-overview-denied">
          <EmptyState
            title="You may not list namespaces"
            body={`You may not list this cluster's namespaces, so only these are used: ${used.join(", ")}.`}
          />
        </div>
      </OverviewPage>
    );
  }

  const quotaTableRows = quotaList.map(
    ({ object, cells }): OverviewRow => ({
      key: objectKey(object),
      name: object.metadata.name,
      sub: object.metadata.namespace ?? "",
      title: objectKey(object),
      onOpen: () => drawer.open(RESOURCE_QUOTAS, objectKey(object)),
      cells: cells.map(donutCell),
    }),
  );
  const perNamespaceTableRows = perNamespace.map(
    ({ object, counts }): OverviewRow => {
      const phase = namespacePhase(object);
      return {
        key: object.metadata.name,
        name: object.metadata.name,
        sub: phase !== "" && phase !== "Active" ? phase : "",
        onOpen: () => drawer.open(NAMESPACES, objectKey(object)),
        cells: counts.map(
          (n, i): OverviewCellValue =>
            n === null
              ? { text: DASH, tone: "dim", title: reasonOf(kinds[i]) }
              : { text: formatCount(n) },
        ),
      };
    },
  );
  const perNamespaceLoading =
    namespaces.state === "loading" || kinds.some((v) => v.state === "loading");
  const perNamespaceEmpty =
    namespaces.state === "unavailable"
      ? { icon: Namespace, ...unavailableState(namespaces, "Namespaces") }
      : { icon: Namespace, title: "No namespaces", text: "" };

  return (
    <OverviewPage
      title="Namespaces overview"
      testId="namespaces-overview"
      namespaces={chosen}
      onKeyDown={drawer.onKeyDown}
    >
      <OverviewGrid>
        <OverviewCell span={5}>
          <TopNamespacesCard
            clusterId={clusterId}
            resources={resources}
            onOpen={(key) => drawer.open(NAMESPACES, key)}
          />
        </OverviewCell>
        <OverviewCell span={7}>
          <OverviewCard
            title="Summary"
            testId="namespaces-overview-card-summary"
          >
            <TileGrid tiles={tiles} />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={12}>
          <OverviewCard
            title="Quota usage"
            testId="namespaces-overview-card-quotas"
          >
            <OverviewTable
              id="namespaces-quotas"
              label="Quota usage"
              columns={QUOTA_COLUMNS}
              rows={quotaTableRows}
              minWidth={400}
              loading={quotas.state === "loading"}
              empty={{ icon: SlidersHorizontal, ...quotaEmpty(quotas, chosen) }}
            />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={12}>
          <OverviewCard
            title="Pods and workloads per namespace"
            testId="namespaces-overview-card-per-namespace"
          >
            <OverviewTable
              id="namespaces-per-namespace"
              label="Pods and workloads per namespace"
              columns={PER_NAMESPACE_COLUMNS}
              rows={perNamespaceTableRows}
              minWidth={580}
              loading={perNamespaceLoading}
              empty={perNamespaceEmpty}
            />
          </OverviewCard>
        </OverviewCell>
      </OverviewGrid>
      {drawer.drawer}
    </OverviewPage>
  );
}
