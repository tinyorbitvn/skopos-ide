import { clusterRelease } from "../../app/clusterStatus";
import type { Tone } from "../../design/Badge";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import type { NodeReady } from "../../ipc/generated/NodeReady";
import type { PodState } from "../../ipc/generated/PodState";
import type { TopologyNode } from "../../ipc/generated/TopologyNode";
import type { TopologyPod } from "../../ipc/generated/TopologyPod";
import type { TopologyRegion } from "../../ipc/generated/TopologyRegion";
import type { TopologySnapshot } from "../../ipc/generated/TopologySnapshot";
import type { TopologyTaint } from "../../ipc/generated/TopologyTaint";
import type { TopologyZone } from "../../ipc/generated/TopologyZone";
import type { UsageItem } from "../../ipc/generated/UsageItem";
import { conditionTone } from "../../kinds/nodes/nodeConditions";
import { percentOf, type UsageView } from "../../kinds/usageColumns";
import { oneDecimal, usable } from "../metrics/format";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Byte order, as the core sorts names. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Whether a node's name or one of its label values holds `query`, ignoring case. */
export function nodeMatches(node: TopologyNode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  if (node.name.toLowerCase().includes(needle)) return true;
  return Object.values(node.labels).some(
    (value) =>
      typeof value === "string" && value.toLowerCase().includes(needle),
  );
}

/**
 * The regions with only their matching nodes, without empty zones and regions, and with
 * the region counts following the filter. Without a query, the same array.
 */
export function filterRegions(
  regions: TopologyRegion[],
  query: string,
): TopologyRegion[] {
  if (query.trim() === "") return regions;
  const out: TopologyRegion[] = [];
  for (const region of regions) {
    const zones: TopologyZone[] = [];
    for (const zone of region.zones) {
      const nodes = zone.nodes.filter((node) => nodeMatches(node, query));
      if (nodes.length > 0) zones.push({ ...zone, nodes });
    }
    if (zones.length === 0) continue;
    const nodes = zones.flatMap((zone) => zone.nodes);
    out.push({
      ...region,
      zones,
      nodeCount: nodes.length,
      podCount: nodes.reduce((sum, node) => sum + node.pods.length, 0),
    });
  }
  return out;
}

export function nodeTotal(regions: readonly TopologyRegion[]): number {
  return regions.reduce((sum, region) => sum + region.nodeCount, 0);
}

/** The toolbar's count: the node total, or "4 of 12" while a filter is on. */
export function countText(
  shown: number,
  total: number,
  filtering: boolean,
): string {
  return filtering ? `${shown} of ${total}` : String(total);
}

/** Every namespace with a pod in the snapshot, sorted: the highlight menu's entries. */
export function mapNamespaces(snapshot: TopologySnapshot): string[] {
  const names = new Set<string>();
  for (const region of snapshot.regions) {
    for (const zone of region.zones) {
      for (const node of zone.nodes) {
        for (const pod of node.pods) names.add(pod.namespace);
      }
    }
  }
  return [...names].sort(compare);
}

/** "1 node", "2 nodes". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The cluster box's label (topology spec §3.3): "<cluster> · <distribution> <version>"
 * while connected, with the release as the cluster switcher names it; else the name alone.
 */
export function clusterLabel(
  name: string,
  state: ConnectionState | undefined,
): string {
  if (state?.status !== "connected") return name;
  const { distribution, version } = clusterRelease(state.info);
  return version === ""
    ? `${name} · ${distribution}`
    : `${name} · ${distribution} ${version}`;
}

/**
 * "<region> · Region · N nodes · M pods", or "No region · N nodes · M pods"; without the
 * pods part while pods are hidden.
 */
export function regionLabel(
  region: TopologyRegion,
  podsHidden: boolean,
): string {
  const parts = region.name === null ? ["No region"] : [region.name, "Region"];
  parts.push(plural(region.nodeCount, "node"));
  if (!podsHidden) parts.push(plural(region.podCount, "pod"));
  return parts.join(" · ");
}

/** "<zone> · Zone · N nodes", or "No zone · N nodes". */
export function zoneLabel(zone: TopologyZone): string {
  const parts = zone.name === null ? ["No zone"] : [zone.name, "Zone"];
  parts.push(plural(zone.nodes.length, "node"));
  return parts.join(" · ");
}

/** The legend's order (topology spec §3.2). */
export const STATE_ORDER: readonly PodState[] = [
  "Running",
  "Pending",
  "Failed",
  "Succeeded",
  "Unknown",
];

/** The status dot of a node's header. */
export const READY_TONE: Record<NodeReady, Tone> = {
  Ready: "ok",
  NotReady: "danger",
  Unknown: "neutral",
};

export interface ConditionBadge {
  label: string;
  tone: Tone;
}

/** NotReady first, then the core's conditions (worst first), in `nodeConditions`' tones. */
export function conditionBadges(node: TopologyNode): ConditionBadge[] {
  const badges: ConditionBadge[] =
    node.ready === "NotReady" ? [{ label: "NotReady", tone: "danger" }] : [];
  for (const type of node.conditions) {
    badges.push({ label: type, tone: conditionTone(type) });
  }
  return badges;
}

/** `key=value:Effect`, or `key:Effect` for a taint without a value. */
export function taintLine(taint: TopologyTaint): string {
  return taint.value === null
    ? `${taint.key}:${taint.effect}`
    : `${taint.key}=${taint.value}:${taint.effect}`;
}

/** The metrics polling serves node usage: it is on and has at least one node. */
export function usageServed(view: UsageView | undefined): boolean {
  return (
    view !== undefined &&
    !view.notServed &&
    view.items !== null &&
    view.items.size > 0
  );
}

export function sourceNote(served: boolean): string {
  return served
    ? "CPU and memory: usage from metrics-server"
    : "CPU and memory: requests, metrics unavailable";
}

/** One of a card's two donuts, as `UsageDonut` takes it. */
export interface UsageFigure {
  name: "CPU" | "Memory";
  /** The whole percent of allocatable used, or null when an amount is unknown. */
  pct: number | null;
  /** Such as "2.1" and "4", or null with `pct`. */
  used: string | null;
  total: string | null;
  unit: string;
}

function figure(
  name: UsageFigure["name"],
  used: number | null,
  total: number | null,
  format: (amount: number) => string,
  unit: string,
): UsageFigure {
  const pct = used !== null && usable(used) ? percentOf({ used, total }) : null;
  if (pct === null || used === null || total === null) {
    return { name, pct: null, used: null, total: null, unit };
  }
  return { name, pct, used: format(used), total: format(total), unit };
}

/** CPU against allocatable: metrics-server's usage when it has the node, else the requests. */
export function cpuUsage(
  node: TopologyNode,
  usage: UsageItem | undefined,
): UsageFigure {
  const used =
    usage === undefined ? node.requests.cpuMillis : usage.cpuCores * 1000;
  return figure(
    "CPU",
    used,
    node.allocatable.cpuMillis,
    (millis) => oneDecimal(millis / 1000),
    "cores",
  );
}

/** Memory against allocatable, in GiB from a 1 GiB total and in MiB below it. */
export function memoryUsage(
  node: TopologyNode,
  usage: UsageItem | undefined,
): UsageFigure {
  const total = node.allocatable.memoryBytes;
  const used =
    usage === undefined ? node.requests.memoryBytes : usage.memoryBytes;
  const gib = total !== null && total >= GIB;
  const size = gib ? GIB : MIB;
  return figure(
    "Memory",
    used,
    total,
    (bytes) => oneDecimal(bytes / size),
    gib ? "GiB" : "MiB",
  );
}

/** "N / P pods", or "N pods" without an allocatable pod count. */
export function podCountText(node: TopologyNode): string {
  const max = node.allocatable.pods;
  return max === null
    ? plural(node.pods.length, "pod")
    : `${node.pods.length} / ${max} pods`;
}

/** The key the drawer's `?object=` names. */
export function podKey(pod: TopologyPod): string {
  return `${pod.namespace}/${pod.name}`;
}

/** "<namespace>/<name> · <status text>". */
export function podTip(pod: TopologyPod): string {
  return `${pod.namespace}/${pod.name} · ${pod.status}`;
}

export interface PodGroup {
  namespace: string;
  pods: TopologyPod[];
}

/** A node's pods by namespace, namespaces sorted, then by name (topology spec §3.4). */
export function namespaceGroups(pods: readonly TopologyPod[]): PodGroup[] {
  const sorted = [...pods].sort(
    (a, b) => compare(a.namespace, b.namespace) || compare(a.name, b.name),
  );
  const groups: PodGroup[] = [];
  for (const pod of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.namespace === pod.namespace) {
      last.pods.push(pod);
    } else {
      groups.push({ namespace: pod.namespace, pods: [pod] });
    }
  }
  return groups;
}

/** The square that keyboard moves start from, remembered by its pod and its place. */
export interface ActiveSquare {
  key: string;
  index: number;
}

/**
 * The active square among a grid's current pod keys: the same pod while it is there,
 * else the square at its index, clamped to the last; null without squares. The same
 * object when nothing changed.
 */
export function resolveActive(
  active: ActiveSquare | null,
  keys: readonly string[],
): ActiveSquare | null {
  if (active === null || keys.length === 0) return null;
  const index = keys.indexOf(active.key);
  if (index !== -1) {
    return index === active.index ? active : { key: active.key, index };
  }
  const place = Math.min(active.index, keys.length - 1);
  return { key: keys[place] ?? active.key, index: place };
}
