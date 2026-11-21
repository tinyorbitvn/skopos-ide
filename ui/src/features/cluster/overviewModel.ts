import type { TopologyNode } from "../../ipc/generated/TopologyNode";
import type { TopologySnapshot } from "../../ipc/generated/TopologySnapshot";
import { eventLastSeen, eventStatus } from "../../kinds/cluster/cluster";
import { resourcePath } from "../../kinds/nav";
import { formatAge, type KubeObject } from "../../kinds/objects";
import { percentOf, type UsageView } from "../../kinds/usageColumns";
import { podStatus } from "../../kinds/workloads/pod";
import { columnMemory, formatCores, oneDecimal } from "../metrics/format";
import type { CapacityItem, TileTone, TopRow } from "../overview";
import { plural, sourceNote, usageServed } from "../topology/model";
import type { KindRow, ListView } from "../workloads/counts";
import { clusterPath } from "./sidebarModel";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DASH = "—";

/** "In the last hour": at most this long before now (spec §5). */
export const RECENT_MS = 3_600_000;
/** Rows in each top table (spec §3.5). */
export const TOP_LIMIT = 5;
/** A namespace caption longer than this counts the namespaces instead (R8). */
const CAPTION_MAX = 60;

const count = (n: number) => n.toLocaleString("en-US");

/** The snapshot's nodes, region by region and zone by zone. */
export function nodesOf(snapshot: TopologySnapshot): TopologyNode[] {
  return snapshot.regions.flatMap((r) => r.zones.flatMap((z) => z.nodes));
}

/** The sum of the known values; null when none is known. */
function sumKnown(values: readonly (number | null)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v !== null && Number.isFinite(v)) sum = (sum ?? 0) + v;
  }
  return sum;
}

export interface CapacityTotals {
  /** Allocatable CPU in cores. */
  cores: number | null;
  /** Allocatable memory in bytes. */
  bytes: number | null;
  /** Allocatable pods. */
  pods: number | null;
}

export interface Capacity {
  items: CapacityItem[];
  caption: string;
  totals: CapacityTotals;
}

const NO_TOTALS: CapacityTotals = { cores: null, bytes: null, pods: null };

function noData(key: string, name: string, unit: string): CapacityItem {
  return {
    key,
    name,
    label: name,
    pct: null,
    used: null,
    total: null,
    unit,
    note: null,
  };
}

/** A donut of an amount against a total, its texts formatted; no data when either is unknown. */
function item(
  base: { key: string; name: string; label: string; unit: string },
  used: number | null,
  total: number | null,
  format: (n: number) => string,
  note: string | null,
): CapacityItem {
  const pct =
    used === null || total === null ? null : percentOf({ used, total });
  if (pct === null || used === null || total === null) {
    return { ...base, pct: null, used: null, total: null, note: null };
  }
  return { ...base, pct, used: format(used), total: format(total), note };
}

/**
 * The Capacity card (spec §3.2): CPU, memory and Pods of the topology's nodes, with usage from
 * metrics-server where it has the node and the node's requests where it has not, as the topology
 * does per node. Null while the first snapshot loads.
 */
export function capacityOf(input: {
  snapshot: TopologySnapshot | null;
  error: string | null;
  nodesForbidden: boolean;
  usage: UsageView | undefined;
}): Capacity | null {
  const blank = [
    noData("cpu", "CPU", "cores"),
    noData("memory", "Memory", "GiB"),
    noData("pods", "Pods", "pods"),
  ];
  if (input.nodesForbidden) {
    return {
      items: blank,
      caption:
        "Capacity is not shown: your account may not list nodes, so allocatable cannot be summed.",
      totals: NO_TOTALS,
    };
  }
  if (input.snapshot === null) {
    if (input.error === null) return null;
    return {
      items: blank,
      caption: `Capacity could not be read: ${input.error.replace(/\.+$/, "")}.`,
      totals: NO_TOTALS,
    };
  }
  const { snapshot, usage } = input;
  const nodes = nodesOf(snapshot);
  const served = usageServed(usage);
  const sample = (node: TopologyNode) =>
    served ? usage?.items?.get(node.name) : undefined;

  const cpuTotal = sumKnown(nodes.map((n) => n.allocatable.cpuMillis));
  const cpuRequests = sumKnown(nodes.map((n) => n.requests.cpuMillis));
  const cpuUsed = sumKnown(
    nodes.map((n) => {
      const s = sample(n);
      return s === undefined ? n.requests.cpuMillis : s.cpuCores * 1000;
    }),
  );
  const memTotal = sumKnown(nodes.map((n) => n.allocatable.memoryBytes));
  const memRequests = sumKnown(nodes.map((n) => n.requests.memoryBytes));
  const memUsed = sumKnown(
    nodes.map((n) => {
      const s = sample(n);
      return s === undefined ? n.requests.memoryBytes : s.memoryBytes;
    }),
  );
  const podTotal = sumKnown(nodes.map((n) => n.allocatable.pods));
  const podsPlaced = nodes.reduce((sum, n) => sum + n.pods.length, 0);

  const requestsNote = (requests: number | null, total: number | null) => {
    if (!served || requests === null || total === null) return null;
    const pct = percentOf({ used: requests, total });
    return pct === null ? null : `Requests ${pct}%`;
  };
  const gib = memTotal !== null && memTotal >= GIB;
  const memSize = gib ? GIB : MIB;

  const items = [
    item(
      {
        key: "cpu",
        name: "CPU",
        label: served ? "CPU" : "CPU requests",
        unit: "cores",
      },
      cpuUsed,
      cpuTotal,
      (millis) => oneDecimal(millis / 1000),
      requestsNote(cpuRequests, cpuTotal),
    ),
    item(
      {
        key: "memory",
        name: "Memory",
        label: served ? "Memory" : "Memory requests",
        unit: gib ? "GiB" : "MiB",
      },
      memUsed,
      memTotal,
      (bytes) => oneDecimal(bytes / memSize),
      requestsNote(memRequests, memTotal),
    ),
    snapshot.podsHidden
      ? noData("pods", "Pods", "pods")
      : item(
          { key: "pods", name: "Pods", label: "Pods", unit: "pods" },
          podsPlaced,
          podTotal,
          count,
          null,
        ),
  ];
  return {
    items,
    caption: sourceNote(served),
    totals: {
      cores: cpuTotal === null ? null : cpuTotal / 1000,
      bytes: memTotal,
      pods: podTotal,
    },
  };
}

// ---- Health

export type TileId = "nodes" | "pods" | "workloads" | "events";

/** A Health tile as `StatTile` draws it, without its icon. */
export interface Tile {
  id: TileId;
  number: string;
  label: string;
  sub: string;
  tone: TileTone;
  /** The list it opens; null disables it. */
  to: string | null;
}

export interface HealthInput {
  clusterId: string;
  snapshot: TopologySnapshot | null;
  topologyError: string | null;
  nodesForbidden: boolean;
  /** The Pods list in the chosen namespaces. */
  pods: ListView;
  /** The rows of Deployments, DaemonSets, StatefulSets, ReplicaSets, Jobs and CronJobs. */
  workloads: KindRow[];
  /** The Events list in the chosen namespaces. */
  events: ListView;
  nowMs: number;
}

/** Pods by the Pods list's Status (R9): Running, Pending (info, warn), Failed (danger). */
export function podGroups(pods: readonly KubeObject[]): {
  total: number;
  running: number;
  pending: number;
  failed: number;
} {
  const groups = { total: 0, running: 0, pending: 0, failed: 0 };
  for (const p of pods) {
    groups.total += 1;
    const { label, tone } = podStatus(p);
    if (label === "Running") groups.running += 1;
    else if (tone === "info" || tone === "warn") groups.pending += 1;
    else if (tone === "danger") groups.failed += 1;
  }
  return groups;
}

/**
 * Warning events last seen at most an hour ago (spec §5), and the latest of them. An event
 * whose time cannot be read is not counted.
 */
export function recentWarnings(
  events: readonly KubeObject[],
  nowMs: number,
): { count: number; latest: KubeObject | null; latestAt: string | null } {
  let n = 0;
  let latest: KubeObject | null = null;
  let latestAt: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (eventStatus(e).label !== "Warning") continue;
    const seen = eventLastSeen(e);
    const at = Date.parse(seen ?? "");
    if (seen === undefined || Number.isNaN(at) || nowMs - at > RECENT_MS)
      continue;
    n += 1;
    if (at > latestMs) {
      latestMs = at;
      latest = e;
      latestAt = seen;
    }
  }
  return { count: n, latest, latestAt };
}

function waitingTile(
  id: TileId,
  label: string,
  view: { state: "loading" } | { state: "unavailable" },
  what: string,
  to: string,
): Tile {
  return {
    id,
    label,
    number: DASH,
    sub: view.state === "loading" ? "Loading" : `Could not list ${what}`,
    tone: "neutral",
    to,
  };
}

function nodesTile(input: HealthInput): Tile {
  const to = resourcePath(input.clusterId, "", "nodes");
  const base = { id: "nodes" as const, label: "Nodes ready" };
  if (input.nodesForbidden) {
    return {
      ...base,
      number: DASH,
      sub: "You may not list nodes",
      tone: "neutral",
      to: null,
    };
  }
  if (input.snapshot === null) {
    return waitingTile(
      "nodes",
      base.label,
      { state: input.topologyError === null ? "loading" : "unavailable" },
      "nodes",
      to,
    );
  }
  const nodes = nodesOf(input.snapshot);
  // kubectl reads a node whose Ready condition is Unknown as NotReady too.
  const notReady = nodes.filter((n) => n.ready !== "Ready").length;
  return {
    ...base,
    number: `${count(nodes.length - notReady)} / ${count(nodes.length)}`,
    sub: notReady > 0 ? `${count(notReady)} NotReady` : "All ready",
    tone: notReady > 0 ? "danger" : "ok",
    to,
  };
}

function podsTile(input: HealthInput): Tile {
  const to = resourcePath(input.clusterId, "", "pods");
  if (input.pods.state !== "ready") {
    return waitingTile("pods", "Pods", input.pods, "Pods", to);
  }
  const g = podGroups(input.pods.items);
  return {
    id: "pods",
    label: "Pods",
    number: count(g.total),
    sub: `${count(g.running)} Running · ${count(g.pending)} Pending · ${count(g.failed)} Failed`,
    tone: g.failed > 0 ? "danger" : g.pending > 0 ? "warn" : "ok",
    to,
  };
}

function workloadsTile(input: HealthInput): Tile {
  const to = clusterPath(input.clusterId, "workloads");
  const label = "Workloads with problems";
  const rows = input.workloads;
  if (rows.some((r) => r.state === "loading")) {
    return waitingTile(
      "workloads",
      label,
      { state: "loading" },
      "workloads",
      to,
    );
  }
  const counted = rows.flatMap((r) =>
    r.state === "counted" ? [r.counts] : [],
  );
  if (counted.length === 0) {
    return waitingTile(
      "workloads",
      label,
      { state: "unavailable" },
      "workloads",
      to,
    );
  }
  const failing = counted.reduce((sum, c) => sum + c.failing, 0);
  const pending = counted.reduce((sum, c) => sum + c.pending, 0);
  return {
    id: "workloads",
    label,
    number: count(failing + pending),
    sub:
      failing + pending === 0
        ? "All healthy"
        : `${count(failing)} failing · ${count(pending)} pending`,
    tone: failing > 0 ? "danger" : pending > 0 ? "warn" : "ok",
    to,
  };
}

function eventsTile(input: HealthInput): Tile {
  const to = resourcePath(input.clusterId, "", "events");
  const label = "Warnings in the last hour";
  if (input.events.state !== "ready") {
    return waitingTile("events", label, input.events, "events", to);
  }
  const recent = recentWarnings(input.events.items, input.nowMs);
  const reason =
    typeof recent.latest?.reason === "string" && recent.latest.reason
      ? recent.latest.reason
      : "Warning";
  return {
    id: "events",
    label,
    number: count(recent.count),
    sub:
      recent.count === 0 || recent.latestAt === null
        ? "No Warning events"
        : `Latest: ${reason}, ${formatAge(recent.latestAt, input.nowMs)} ago`,
    tone: recent.count > 0 ? "warn" : "ok",
    to,
  };
}

/** The Health card's four tiles (spec §3.3), in their order. */
export function healthOf(input: HealthInput): Tile[] {
  return [
    nodesTile(input),
    podsTile(input),
    workloadsTile(input),
    eventsTile(input),
  ];
}

/** The Health card's caption for a namespace selection (R8); null when none is chosen. */
export function namespaceCaption(
  namespaces: readonly string[],
): { text: string; title: string } | null {
  if (namespaces.length === 0) return null;
  const title = namespaces.join(", ");
  const text =
    namespaces.length === 1
      ? `In namespace: ${title}`
      : `In namespaces: ${title}`;
  return text.length > CAPTION_MAX
    ? { text: `In ${count(namespaces.length)} namespaces`, title }
    : { text, title };
}

// ---- Top consumers

export type TopBy = "cpu" | "memory";

/** A top table's row without its handler: `openKey` is the drawer's `?object=`. */
export type TopEntry = Omit<TopRow, "onOpen"> & { openKey: string };

function byAmount(a: TopEntry, b: TopEntry): number {
  if (a.amount !== b.amount) return b.amount - a.amount;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * The namespaces and Pods that use the most CPU or memory (spec §3.5), from metrics-server's
 * Pod usage over the whole cluster. One pass over the Pods, then a sort.
 */
export function topConsumers(
  usage: UsageView | undefined,
  by: TopBy,
  limit = TOP_LIMIT,
): { namespaces: TopEntry[]; pods: TopEntry[] } {
  const items = usage?.items;
  if (!items) return { namespaces: [], pods: [] };
  const text = by === "cpu" ? formatCores : columnMemory;
  const pods: TopEntry[] = [];
  const spaces = new Map<string, { amount: number; pods: number }>();
  for (const i of items.values()) {
    if (i.namespace === null) continue;
    const amount = by === "cpu" ? i.cpuCores : i.memoryBytes;
    if (!Number.isFinite(amount)) continue;
    const key = `${i.namespace}/${i.name}`;
    pods.push({
      key,
      name: i.name,
      sub: i.namespace,
      amount,
      amountText: text(amount),
      openKey: key,
    });
    const space = spaces.get(i.namespace) ?? { amount: 0, pods: 0 };
    space.amount += amount;
    space.pods += 1;
    spaces.set(i.namespace, space);
  }
  const namespaces = [...spaces].map(
    ([name, s]): TopEntry => ({
      key: name,
      name,
      sub: plural(s.pods, "pod"),
      amount: s.amount,
      amountText: text(s.amount),
      openKey: `/${name}`,
    }),
  );
  return {
    namespaces: namespaces.sort(byAmount).slice(0, limit),
    pods: pods.sort(byAmount).slice(0, limit),
  };
}
