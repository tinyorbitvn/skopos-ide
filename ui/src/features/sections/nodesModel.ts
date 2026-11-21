import {
  Activity,
  CirclePause,
  CircleX,
  type IconComponent,
  ShieldCheck,
} from "../../design/icons";
import type { TopologyNode } from "../../ipc/generated/TopologyNode";
import type { TopologySnapshot } from "../../ipc/generated/TopologySnapshot";
import type { UsageItem } from "../../ipc/generated/UsageItem";
import { resourcePath } from "../../kinds/nav";
import type { KubeObject } from "../../kinds/objects";
import { percentOf, type UsageView } from "../../kinds/usageColumns";
import { nodesOf } from "../cluster/overviewModel";
import { oneDecimal, usable } from "../metrics/format";
import type { TileTone, TopRow } from "../overview";
import {
  cpuUsage,
  memoryUsage,
  type UsageFigure,
  usageServed,
} from "../topology/model";
import { countOf, formatCount, naturalCompare, someNames } from "./text";
import { type SectionTile, waitingTile } from "./tiles";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DASH = "—";

/** Rows of Busiest nodes (spec §3.3). */
export const BUSIEST_LIMIT = 5;
/** The name of a zone the topology has no `topology.kubernetes.io/zone` for. */
export const NO_ZONE = "No zone";

/** The conditions Under pressure counts (spec §3.3). */
const PRESSURES = ["MemoryPressure", "DiskPressure", "PIDPressure"];

interface StateBase {
  id: string;
  icon: IconComponent;
  label: string;
}

const READY: StateBase = { id: "ready", icon: ShieldCheck, label: "Ready" };
const NOT_READY: StateBase = {
  id: "not-ready",
  icon: CircleX,
  label: "NotReady",
};
const CORDONED: StateBase = {
  id: "cordoned",
  icon: CirclePause,
  label: "Cordoned",
};
const PRESSURE: StateBase = {
  id: "pressure",
  icon: Activity,
  label: "Under pressure",
};
const STATES = [READY, NOT_READY, CORDONED, PRESSURE];

const nodesList = (clusterId: string) => resourcePath(clusterId, "", "nodes");

function stateTile(
  base: StateBase,
  count: number,
  sub: string,
  tone: TileTone,
  to: string,
): SectionTile {
  return { ...base, number: formatCount(count), sub, tone, to };
}

/** Names, two of them and how many more, or `None`. */
function namesOrNone(nodes: readonly TopologyNode[]): string {
  return nodes.length === 0 ? "None" : someNames(nodes.map((n) => n.name));
}

/**
 * Nodes by state (spec §3.3, §5): Ready, NotReady, Cordoned and Under pressure from the
 * topology, each opening the Nodes list. A cordoned node that is Ready counts in both.
 */
export function nodeStateTiles(
  snapshot: TopologySnapshot,
  clusterId: string,
): SectionTile[] {
  const to = nodesList(clusterId);
  const nodes = nodesOf(snapshot).sort((a, b) =>
    naturalCompare(a.name, b.name),
  );
  const ready = nodes.filter((n) => n.ready === "Ready");
  const notReady = nodes.filter((n) => n.ready !== "Ready");
  const cordoned = nodes.filter((n) => n.unschedulable);
  const pressed = nodes.flatMap((node) => {
    const conditions = node.conditions.filter((c) => PRESSURES.includes(c));
    return conditions.length === 0 ? [] : [{ node, conditions }];
  });
  const pressureSub =
    pressed.length === 1
      ? `${pressed[0].node.name}: ${pressed[0].conditions.join(", ")}`
      : namesOrNone(pressed.map((p) => p.node));
  return [
    stateTile(
      READY,
      ready.length,
      `Of ${countOf(nodes.length, "node")}`,
      "ok",
      to,
    ),
    stateTile(
      NOT_READY,
      notReady.length,
      namesOrNone(notReady),
      notReady.length > 0 ? "danger" : "ok",
      to,
    ),
    stateTile(
      CORDONED,
      cordoned.length,
      namesOrNone(cordoned),
      cordoned.length > 0 ? "warn" : "ok",
      to,
    ),
    stateTile(
      PRESSURE,
      pressed.length,
      pressureSub,
      pressed.length > 0 ? "warn" : "ok",
      to,
    ),
  ];
}

/** The state tiles while the topology loads: a dash and `Loading`, still opening the list. */
export function loadingStateTiles(clusterId: string): SectionTile[] {
  const to = nodesList(clusterId);
  return STATES.map((base) =>
    waitingTile({ state: "loading" }, { ...base, plural: "nodes", to }),
  );
}

/** What Busiest nodes ranks by. */
export type NodesBy = "cpu" | "memory";

/** A Busiest nodes row before the page adds what opens its drawer. */
export type BusyRow = Omit<TopRow, "onOpen"> & {
  own: NonNullable<TopRow["own"]>;
};

/** The snapshot's nodes with the zone the topology puts them in. */
function placedNodes(
  snapshot: TopologySnapshot,
): { node: TopologyNode; zone: string | null }[] {
  return snapshot.regions.flatMap((r) =>
    r.zones.flatMap((z) => z.nodes.map((node) => ({ node, zone: z.name }))),
  );
}

/** `<name> CPU 84%, 13.3 of 15.8 cores`, or `<name> CPU: no data`. */
function figureLabel(name: string, figure: UsageFigure): string {
  return figure.pct === null
    ? `${name} ${figure.name}: no data`
    : `${name} ${figure.name} ${figure.pct}%, ${figure.used} of ${figure.total} ${figure.unit}`;
}

/**
 * Busiest nodes (spec §3.3): the nodes metrics-server has a sample of, by the share of their
 * own allocatable CPU or memory, then by name; at most `limit`. None without node usage.
 */
export function busiestNodes(
  snapshot: TopologySnapshot,
  usage: UsageView | undefined,
  by: NodesBy,
  limit = BUSIEST_LIMIT,
): BusyRow[] {
  if (!usageServed(usage)) return [];
  const ranked: {
    node: TopologyNode;
    zone: string | null;
    sample: UsageItem;
    share: number;
  }[] = [];
  for (const { node, zone } of placedNodes(snapshot)) {
    const sample = usage?.items?.get(node.name);
    if (sample === undefined) continue;
    const used = by === "cpu" ? sample.cpuCores * 1000 : sample.memoryBytes;
    const total =
      by === "cpu" ? node.allocatable.cpuMillis : node.allocatable.memoryBytes;
    if (total === null || !(total > 0) || !usable(used)) continue;
    ranked.push({ node, zone, sample, share: used / total });
  }
  ranked.sort(
    (a, b) => b.share - a.share || naturalCompare(a.node.name, b.node.name),
  );
  return ranked.slice(0, limit).map(({ node, zone, sample }): BusyRow => {
    const figure =
      by === "cpu" ? cpuUsage(node, sample) : memoryUsage(node, sample);
    return {
      key: node.name,
      name: node.name,
      sub: [node.roles.join(", "), zone ?? ""]
        .filter((part) => part !== "")
        .join(" · "),
      amount: by === "cpu" ? sample.cpuCores : sample.memoryBytes,
      amountText: `${figure.used ?? DASH} ${figure.unit}`,
      own: { pct: figure.pct, label: figureLabel(node.name, figure) },
    };
  });
}

/** A 36 px donut of a table cell, without its caption. */
export interface DonutValue {
  pct: number | null;
  used: string | null;
  total: string | null;
  unit: string;
  /** Its accessible name: `eu-west-1a CPU 61%, 31.2 of 51.2 cores`, or `<name>: no data`. */
  label: string;
}

/** An amount against a total as a donut; no data when either is unknown or the total is 0. */
export function donutValue(
  name: string,
  used: number | null,
  total: number | null,
  format: (amount: number) => string,
  unit: string,
): DonutValue {
  const pct =
    used === null || total === null || !usable(used)
      ? null
      : percentOf({ used, total });
  if (pct === null || used === null || total === null) {
    return {
      pct: null,
      used: null,
      total: null,
      unit,
      label: `${name}: no data`,
    };
  }
  const usedText = format(used);
  const totalText = format(total);
  return {
    pct,
    used: usedText,
    total: totalText,
    unit,
    label: `${name} ${pct}%, ${usedText} of ${totalText} ${unit}`,
  };
}

/** The caption beside a donut: `3 / 8 cores`, `2 / 220` for pods, `No data`. */
export function donutCaption(value: DonutValue): string {
  if (value.used === null || value.total === null) return "No data";
  const pair = `${value.used} / ${value.total}`;
  return value.unit === "" || value.unit === "pods"
    ? pair
    : `${pair} ${value.unit}`;
}

/** A row of By zone. */
export interface ZoneRow {
  /** The zone's name, or `No zone`. */
  zone: string;
  /** The region's name, or "" without one. */
  region: string;
  nodes: number;
  cpu: DonutValue;
  memory: DonutValue;
  pods: DonutValue;
}

/** The sum of the known values; null when none is known. */
function sumKnown(values: readonly (number | null)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v !== null && Number.isFinite(v)) sum = (sum ?? 0) + v;
  }
  return sum;
}

/** Natural order, a missing name last. */
function namedFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return naturalCompare(a, b);
}

/**
 * By zone (spec §3.3, §5): a row per zone of the topology, natural order with `No zone` last,
 * then by region. CPU and memory are metrics-server's usage where a node has a sample, else
 * its requests, as Capacity reads them, so the rows sum to Capacity; Pods are the Pods placed
 * against the nodes' allocatable pods.
 */
export function zoneRows(
  snapshot: TopologySnapshot,
  usage: UsageView | undefined,
): ZoneRow[] {
  const served = usageServed(usage);
  const requests = served ? "" : " requests";
  const sample = (node: TopologyNode) =>
    served ? usage?.items?.get(node.name) : undefined;
  const zones = snapshot.regions.flatMap((r) =>
    r.zones.map((z) => ({ region: r.name, zone: z.name, nodes: z.nodes })),
  );
  zones.sort(
    (a, b) => namedFirst(a.zone, b.zone) || namedFirst(a.region, b.region),
  );
  return zones.map(({ region, zone, nodes }): ZoneRow => {
    const name = zone ?? NO_ZONE;
    const cpuUsed = sumKnown(
      nodes.map((n) => {
        const s = sample(n);
        return s === undefined ? n.requests.cpuMillis : s.cpuCores * 1000;
      }),
    );
    const cpuTotal = sumKnown(nodes.map((n) => n.allocatable.cpuMillis));
    const memUsed = sumKnown(
      nodes.map((n) => {
        const s = sample(n);
        return s === undefined ? n.requests.memoryBytes : s.memoryBytes;
      }),
    );
    const memTotal = sumKnown(nodes.map((n) => n.allocatable.memoryBytes));
    const gib = memTotal !== null && memTotal >= GIB;
    const memSize = gib ? GIB : MIB;
    const podsPlaced = nodes.reduce((sum, n) => sum + n.pods.length, 0);
    const podTotal = sumKnown(nodes.map((n) => n.allocatable.pods));
    return {
      zone: name,
      region: region ?? "",
      nodes: nodes.length,
      cpu: donutValue(
        `${name} CPU${requests}`,
        cpuUsed,
        cpuTotal,
        (millis) => oneDecimal(millis / 1000),
        "cores",
      ),
      memory: donutValue(
        `${name} Memory${requests}`,
        memUsed,
        memTotal,
        (bytes) => oneDecimal(bytes / memSize),
        gib ? "GiB" : "MiB",
      ),
      pods: snapshot.podsHidden
        ? donutValue(`${name} Pods`, null, null, formatCount, "pods")
        : donutValue(`${name} Pods`, podsPlaced, podTotal, formatCount, "pods"),
    };
  });
}

/** One of the three Versions tables. */
export interface VersionTable {
  id: "kubelets" | "os-images" | "architectures";
  title: string;
  /** The value column's head. */
  head: string;
  rows: { value: string; nodes: number; sub: string }[];
}

/** A `status.nodeInfo` field of a Node row, or a dash without one. */
function nodeInfo(node: KubeObject, field: string): string {
  const value = node.status?.nodeInfo?.[field];
  return typeof value === "string" && value.trim() !== "" ? value : DASH;
}

/** The distinct values and how many nodes have each, most first, then natural order. */
function tally(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]));
}

/**
 * Versions (spec §3.3, R7): the kubelet versions, OS images and architectures of the Nodes
 * list. Each kubelet version reads against the API server's, unless it is the dash or the
 * API server's version is unknown.
 */
export function versionTables(
  nodes: readonly KubeObject[],
  apiServerVersion: string,
): VersionTable[] {
  const api = apiServerVersion.trim();
  const table = (
    id: VersionTable["id"],
    title: string,
    head: string,
    field: string,
    sub: (value: string) => string,
  ): VersionTable => ({
    id,
    title,
    head,
    rows: tally(nodes.map((n) => nodeInfo(n, field))).map(([value, count]) => ({
      value,
      nodes: count,
      sub: sub(value),
    })),
  });
  const kubeletSub = (value: string) =>
    value === DASH || api === ""
      ? ""
      : value === api
        ? "Same as the API server"
        : `API server ${api}`;
  const none = () => "";
  return [
    table(
      "kubelets",
      "Kubelet versions",
      "Version",
      "kubeletVersion",
      kubeletSub,
    ),
    table("os-images", "OS images", "OS image", "osImage", none),
    table(
      "architectures",
      "Architectures",
      "Architecture",
      "architecture",
      none,
    ),
  ];
}

/** `Could not read the nodes: <error>.` (spec §7). */
export function nodesError(error: string): string {
  return `Could not read the nodes: ${error.replace(/\.+$/, "")}.`;
}
