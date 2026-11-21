import { useMemo } from "react";
import { useNow } from "../../design";
import {
  EventStream,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
} from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { findResource } from "../../stores/resources";
import { useClusterContext } from "../cluster/ClusterLayout";
import { servedResourceOf } from "../details/ownerLinks";
import {
  CapacityRow,
  OverviewCard,
  OverviewCell,
  OverviewGrid,
} from "../overview";
import { OverviewPage } from "../overview/OverviewPage";
import {
  type OverviewColumn,
  type OverviewRow,
  OverviewTable,
  type OverviewTableProps,
} from "../overview/OverviewTable";
import {
  type SectionShared,
  useSectionShared,
  useSectionView,
} from "../sections/sectionLists";
import { formatCount, objectKey, openKeyOf } from "../sections/text";
import { TileGrid } from "../sections/tiles";
import { useOverviewDrawer } from "../sections/useOverviewDrawer";
import { type ListView, WORKLOAD_KINDS, type WorkloadKind } from "./counts";
import {
  eventSubject,
  kindName,
  kindRowOf,
  kindTiles,
  problemWorkloads,
  recentEventRows,
  workloadHealth,
} from "./workloadsModel";

type Empty = OverviewTableProps["empty"];

const [
  PODS,
  DEPLOYMENTS,
  DAEMONSETS,
  STATEFULSETS,
  REPLICASETS,
  JOBS,
  CRONJOBS,
] = WORKLOAD_KINDS;

const HEALTH_COLUMNS: OverviewColumn[] = [
  { head: "Kind", width: "minmax(0, 1fr)" },
  { head: "Healthy", width: "64px", align: "end" },
  { head: "Pending", width: "64px", align: "end" },
  { head: "Failing", width: "64px", align: "end" },
];

const PROBLEM_COLUMNS: OverviewColumn[] = [
  { head: "Workload", width: "minmax(0, 1.2fr)" },
  { head: "Kind", width: "88px" },
  { head: "Status", width: "minmax(0, 1fr)" },
];

const EVENT_COLUMNS: OverviewColumn[] = [
  { head: "Object", width: "minmax(140px, 1fr)" },
  { head: "Type", width: "80px" },
  { head: "Message", width: "minmax(0, 2.4fr)" },
  { head: "Age", width: "56px", align: "end" },
];

const NO_WORKLOADS: Empty = {
  icon: ShieldOff,
  title: "You may not list workloads",
  text: "",
};
const ALL_HEALTHY: Empty = {
  icon: ShieldCheck,
  title: "Every workload is healthy",
  text: "",
};
const NO_EVENTS: Empty = {
  icon: EventStream,
  title: "No recent events",
  text: "Events of the selected namespaces show here.",
};

/** What Recent events says without rows: none yet, or why its list is not there (spec §3.1, §3.2). */
function eventsEmpty(view: ListView): Empty {
  if (view.state !== "unavailable") return NO_EVENTS;
  if (view.cause === "forbidden") {
    return { icon: ShieldOff, title: "You may not list events", text: "" };
  }
  if (view.cause === "notServed") {
    return {
      icon: EventStream,
      title: "This cluster does not serve events",
      text: "",
    };
  }
  return {
    icon: TriangleAlert,
    title: "Could not list events",
    text: view.reason,
  };
}

/** A workload kind's list under the namespace selection. */
function useKindView(shared: SectionShared, kind: WorkloadKind): ListView {
  return useSectionView(shared, kind.label, kind.group, kind.plural);
}

/**
 * The kinds the drawer may open (spec §3.2, R5): the workload kinds, and the kinds the events
 * name that discovery lists and the account may list.
 */
function openableOf(
  resources: ApiResourceInfo[],
  events: ListView,
): ResourceRef[] {
  const refs = new Map<string, ResourceRef>();
  const add = (info: ApiResourceInfo | undefined) => {
    if (info?.canList) refs.set(openKeyOf(info.resource), info.resource);
  };
  for (const kind of WORKLOAD_KINDS) {
    add(findResource(resources, kind.group, kind.plural));
  }
  if (events.state === "ready") {
    for (const event of events.items) {
      const subject = eventSubject(event);
      if (subject !== null) add(servedResourceOf(subject, resources));
    }
  }
  return [...refs.values()];
}

/**
 * Recent events (spec §3.2). A component of its own, so the clock that ages the events
 * re-renders only this table.
 */
function RecentEvents(props: {
  view: ListView;
  resources: ApiResourceInfo[];
  onOpen(ref: ResourceRef, key: string): void;
}) {
  const { view, resources, onOpen } = props;
  const now = useNow();
  // The shared clock moves every 30 s; a list that just arrived is aged from now.
  const rows = useMemo(
    () => recentEventRows(view, Math.max(now, Date.now())),
    [view, now],
  );
  const tableRows = (rows ?? []).map((row): OverviewRow => {
    const { target } = row;
    const info =
      target === null ? undefined : servedResourceOf(target, resources);
    return {
      key: row.event.metadata.uid ?? objectKey(row.event),
      name: row.name,
      sub: row.sub,
      onOpen:
        target !== null && info?.canList
          ? () => onOpen(info.resource, target.key)
          : undefined,
      cells: [
        row.type === "Warning"
          ? { text: row.type, tone: "warn" }
          : { text: row.type },
        { text: row.message, title: row.message },
        { text: row.age },
      ],
    };
  });
  return (
    <OverviewTable
      id="workloads-events"
      label="Recent events"
      columns={EVENT_COLUMNS}
      rows={tableRows}
      minWidth={560}
      loading={view.state === "loading"}
      empty={eventsEmpty(view)}
    />
  );
}

/**
 * The Workloads overview (section overviews spec §3.2): the workload kinds as tiles, their
 * health, the workloads with problems and the recent events, under the lists' namespace
 * selection, with the drawer over the page.
 */
export function WorkloadsOverview() {
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const discovery = useMemo(
    () => ({ loading: resourcesLoading, error: resourcesError }),
    [resourcesLoading, resourcesError],
  );
  const shared = useSectionShared(clusterId, resources, discovery);
  const namespaces = shared[3];
  // One call per kind of the Workloads section, in its order: hooks may not loop (R2).
  const pods = useKindView(shared, PODS);
  const deployments = useKindView(shared, DEPLOYMENTS);
  const daemonSets = useKindView(shared, DAEMONSETS);
  const statefulSets = useKindView(shared, STATEFULSETS);
  const replicaSets = useKindView(shared, REPLICASETS);
  const jobs = useKindView(shared, JOBS);
  const cronJobs = useKindView(shared, CRONJOBS);
  const events = useSectionView(shared, "Events", "", "events");

  const views = useMemo(
    () => [
      { kind: PODS, view: pods },
      { kind: DEPLOYMENTS, view: deployments },
      { kind: DAEMONSETS, view: daemonSets },
      { kind: STATEFULSETS, view: statefulSets },
      { kind: REPLICASETS, view: replicaSets },
      { kind: JOBS, view: jobs },
      { kind: CRONJOBS, view: cronJobs },
    ],
    [pods, deployments, daemonSets, statefulSets, replicaSets, jobs, cronJobs],
  );
  const rows = useMemo(
    () => views.map(({ kind, view }) => kindRowOf(kind, view)),
    [views],
  );
  const tiles = useMemo(() => kindTiles(rows, clusterId), [rows, clusterId]);
  const health = useMemo(() => workloadHealth(rows), [rows]);
  const problems = useMemo(() => problemWorkloads(views), [views]);
  // Health and problems wait for every kind, so their numbers do not jump.
  const loading = rows.some((row) => row.state === "loading");
  const openable = useMemo(
    () => openableOf(resources, events),
    [resources, events],
  );
  const drawer = useOverviewDrawer(clusterId, resources, openable);

  const problemRows = problems.items.map(
    ({ object, kind, status, failing }): OverviewRow => {
      const info = findResource(resources, kind.group, kind.plural);
      const key = objectKey(object);
      return {
        key: `${kind.plural}/${key}`,
        name: object.metadata.name,
        sub: object.metadata.namespace ?? "",
        title: key,
        onOpen: info ? () => drawer.open(info.resource, key) : undefined,
        cells: [
          { text: kindName(kind) },
          { text: status.label, tone: failing ? "bad" : "warn" },
        ],
      };
    },
  );
  const footer =
    problems.total > problems.items.length
      ? `Showing ${formatCount(problems.items.length)} of ${formatCount(problems.total)}. The lists show them all.`
      : undefined;

  return (
    <OverviewPage
      title="Workloads overview"
      testId="workloads-overview"
      namespaces={namespaces}
      onKeyDown={drawer.onKeyDown}
    >
      <OverviewGrid>
        <OverviewCell span={12}>
          <OverviewCard
            title="Workloads by kind"
            testId="workloads-overview-card-kinds"
          >
            <TileGrid tiles={tiles} />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={5}>
          <OverviewCard title="Health" testId="workloads-overview-card-health">
            {!loading && health !== null ? (
              <CapacityRow items={[health.donut]} />
            ) : null}
            <OverviewTable
              id="workloads-health"
              title="Health by kind"
              label="Health by kind"
              columns={HEALTH_COLUMNS}
              rows={health === null ? [] : health.rows}
              loading={loading}
              empty={NO_WORKLOADS}
            />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={7}>
          <OverviewCard
            title="Workloads with problems"
            testId="workloads-overview-card-problems"
          >
            <OverviewTable
              id="workloads-problems"
              label="Workloads with problems"
              columns={PROBLEM_COLUMNS}
              rows={problemRows}
              loading={loading}
              empty={health === null ? NO_WORKLOADS : ALL_HEALTHY}
              footer={footer}
            />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={12}>
          <OverviewCard
            title="Recent events"
            testId="workloads-overview-card-events"
          >
            <RecentEvents
              view={events}
              resources={resources}
              onOpen={(ref, key) => drawer.open(ref, key)}
            />
          </OverviewCard>
        </OverviewCell>
      </OverviewGrid>
      {drawer.drawer}
    </OverviewPage>
  );
}
