import type { LabelMatcher } from "../../ipc/generated/LabelMatcher";
import type { MetricName } from "../../ipc/generated/MetricName";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsRange } from "../../ipc/generated/MetricsRange";
import type { MetricsResult } from "../../ipc/generated/MetricsResult";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import {
  formatBytes,
  formatCount,
  gibibytes,
  type MetricUnit,
  oneDecimal,
  usable,
} from "./format";

/** Where a panel's charts come from. */
export type MetricsSource = "prometheus" | "metricsServer";

/** One line of a chart: the metric it reads and the name the labels and readout give it. */
export interface SeriesDef {
  metric: MetricName;
  name: string;
}

/** One chart of a target (spec D2 §9 and §10.3). */
export interface ChartDef {
  stem: string;
  title: string;
  sub: string;
  unit: MetricUnit;
  main: SeriesDef;
  /** Drawn below the baseline (Network's Sent). */
  mirror: SeriesDef | null;
  refs: SeriesDef[];
}

/** What the subs say about the target; null when it is not known. */
export interface TargetFacts {
  allocatableCores: number | null;
  allocatableBytes: number | null;
  nodeCount: number | null;
  podCapacity: number | null;
  podCount: number | null;
  /** A PVC's capacity, already formatted ("10 GiB"). */
  capacityText: string | null;
}

export const NO_FACTS: TargetFacts = {
  allocatableCores: null,
  allocatableBytes: null,
  nodeCount: null,
  podCapacity: null,
  podCount: null,
  capacityText: null,
};

/** "over the last ‹period›" in a chart's label. */
export const RANGE_PERIOD: Record<MetricsRange, string> = {
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
  "7d": "7 days",
};

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The value of the last point that has a usable one; null when none has. */
export function lastValue(
  points: [number, number][] | undefined,
): number | null {
  if (!points) return null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const value = points[i][1];
    if (usable(value)) return value;
  }
  return null;
}

/** Facts a Prometheus answer carries: allocatable CPU and memory, Pod and disk capacity. */
export function factsFromResult(
  result: MetricsResult | null,
): Partial<TargetFacts> {
  if (!result) return {};
  const read = (metric: MetricName): number | null =>
    result.missing.includes(metric) ? null : lastValue(result.series[metric]);
  const facts: Partial<TargetFacts> = {};
  const cores = read("cpuAllocatable");
  if (cores !== null) facts.allocatableCores = cores;
  const bytes = read("memoryAllocatable");
  if (bytes !== null) facts.allocatableBytes = bytes;
  const pods = read("podCapacity");
  if (pods !== null) facts.podCapacity = pods;
  const disk = read("diskCapacity");
  if (disk !== null) facts.capacityText = formatBytes(disk);
  return facts;
}

/** The caller's facts, with the ones it does not know taken from the answer. */
export function mergeFacts(
  caller: TargetFacts,
  fromResult: Partial<TargetFacts>,
): TargetFacts {
  return {
    allocatableCores:
      caller.allocatableCores ?? fromResult.allocatableCores ?? null,
    allocatableBytes:
      caller.allocatableBytes ?? fromResult.allocatableBytes ?? null,
    nodeCount: caller.nodeCount ?? fromResult.nodeCount ?? null,
    podCapacity: caller.podCapacity ?? fromResult.podCapacity ?? null,
    podCount: caller.podCount ?? fromResult.podCount ?? null,
    capacityText: caller.capacityText ?? fromResult.capacityText ?? null,
  };
}

function known(n: number | null): number | null {
  return n !== null && usable(n) ? n : null;
}

/** The parts that are known, joined with a space; "" when none is. */
function words(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join(" ");
}

function ofCores(cores: number | null): string | null {
  if (cores === null) return null;
  const text = oneDecimal(cores);
  return `of ${text} ${text === "1" ? "core" : "cores"}`;
}

function ofGibibytes(bytes: number | null): string | null {
  return bytes === null ? null : `of ${gibibytes(bytes)} GiB`;
}

function onNodes(nodes: number | null): string | null {
  return nodes === null ? null : `on ${plural(nodes, "node", "nodes")}`;
}

function cpuChart(sub: string, refs: SeriesDef[]): ChartDef {
  return {
    stem: "cpu",
    title: "CPU",
    sub,
    unit: "cores",
    main: { metric: "cpuUsage", name: "Usage" },
    mirror: null,
    refs,
  };
}

function memoryChart(sub: string, refs: SeriesDef[]): ChartDef {
  return {
    stem: "memory",
    title: "Memory",
    sub,
    unit: "bytes",
    main: { metric: "memoryUsage", name: "Working set" },
    mirror: null,
    refs,
  };
}

/** Cluster and node charts sum many Pods: "Requests" and "Limits". */
function nodeRefs(kind: "cpu" | "memory"): SeriesDef[] {
  return [
    { metric: `${kind}Requests`, name: "Requests" },
    { metric: `${kind}Limits`, name: "Limits" },
  ];
}

/** A Pod or a workload: "Request" and "Limit". */
function podRefs(kind: "cpu" | "memory"): SeriesDef[] {
  return [
    { metric: `${kind}Requests`, name: "Request" },
    { metric: `${kind}Limits`, name: "Limit" },
  ];
}

function podsChart(sub: string): ChartDef {
  return {
    stem: "pods",
    title: "Pods",
    sub,
    unit: "count",
    main: { metric: "podUsage", name: "Running" },
    mirror: null,
    refs: [{ metric: "podCapacity", name: "Capacity" }],
  };
}

function diskChart(sub: string): ChartDef {
  return {
    stem: "disk",
    title: "Disk",
    sub,
    unit: "bytes",
    main: { metric: "diskUsage", name: "Used" },
    mirror: null,
    refs: [{ metric: "diskCapacity", name: "Capacity" }],
  };
}

function networkChart(): ChartDef {
  return {
    stem: "network",
    title: "Network",
    sub: "received above, sent below",
    unit: "bytesPerSecond",
    main: { metric: "networkReceive", name: "Received" },
    mirror: { metric: "networkTransmit", name: "Sent" },
    refs: [],
  };
}

function filesystemChart(): ChartDef {
  return {
    stem: "filesystem",
    title: "Filesystem",
    sub: "container writable layers",
    unit: "bytes",
    main: { metric: "fsUsage", name: "Used" },
    mirror: null,
    refs: [],
  };
}

function volumeChart(capacityText: string | null): ChartDef {
  return {
    stem: "volume",
    title: "Volume usage",
    sub: capacityText === null ? "" : `capacity ${capacityText}`,
    unit: "bytes",
    main: { metric: "diskUsage", name: "Used" },
    mirror: null,
    refs: [{ metric: "diskCapacity", name: "Capacity" }],
  };
}

/** The control plane's target: the API server's own metrics (spec §3.6). */
export const CONTROL_PLANE: MetricsTarget = { kind: "controlPlane" };

/** The control plane's metrics, in the order core answers them. */
export const CONTROL_PLANE_METRICS: readonly MetricName[] = [
  "apiRequests",
  "apiErrors",
  "apiLatencyP99",
  "etcdLatencyP99",
  "etcdDbSize",
];

/** Distributions whose provider runs etcd, out of the cluster's reach. */
const MANAGED_ETCD = new Set(["EKS", "GKE", "AKS"]);
/** Distributions that run etcd themselves, with its 2 GiB default unless someone changed it. */
const DEFAULT_QUOTA = new Set([
  "kind",
  "minikube",
  "k3s",
  "rke2",
  "Kubernetes",
]);

/**
 * What the etcd database chart's sub-line says about its limit. EKS's 8 GiB holds on standard
 * control planes only; GKE and AKS publish none, and a self-managed quota may be changed.
 */
export function etcdDatabaseSub(distribution: string): string {
  if (distribution === "EKS") return "8 GiB on standard control planes";
  if (DEFAULT_QUOTA.has(distribution)) return "etcd's default quota is 2 GiB";
  return "size on disk";
}

/** The control plane's four charts, in their 2-by-2 order: the API server's, then etcd's. */
export function controlPlaneCharts(distribution: string): ChartDef[] {
  return [
    {
      stem: "api-requests",
      title: "API requests",
      sub: "all verbs",
      unit: "requestsPerSecond",
      main: { metric: "apiRequests", name: "Requests" },
      mirror: null,
      refs: [{ metric: "apiErrors", name: "5xx errors" }],
    },
    {
      stem: "api-latency",
      title: "API latency",
      sub: "p99, without WATCH",
      unit: "seconds",
      main: { metric: "apiLatencyP99", name: "p99" },
      mirror: null,
      refs: [],
    },
    {
      stem: "etcd-latency",
      title: "etcd latency",
      sub: "p99 of the API server's requests",
      unit: "seconds",
      main: { metric: "etcdLatencyP99", name: "p99" },
      mirror: null,
      refs: [],
    },
    {
      stem: "etcd-database",
      title: "etcd database",
      sub: etcdDatabaseSub(distribution),
      unit: "bytes",
      main: { metric: "etcdDbSize", name: "Size" },
      mirror: null,
      refs: [],
    },
  ];
}

/** The control plane group's source caption. */
export function controlPlaneNote(distribution: string): string {
  return MANAGED_ETCD.has(distribution)
    ? `From the API server's own metrics: ${distribution} runs etcd, so etcd is read as the API server sees it.`
    : "From the API server's own metrics, etcd as the API server sees it.";
}

/** The note in place of the four charts when this Prometheus has no API server samples. */
export function controlPlaneMissingNote(matcher: LabelMatcher | null): string {
  const label = matcher === null ? "" : ` with ${labelText(matcher)}`;
  return `No API server metrics in this Prometheus: there are no samples of apiserver_request_total${label}. kube-prometheus-stack scrapes the API server by default; another Prometheus needs a job for the kubernetes Service's endpoints.`;
}

/** All five control plane queries answered with no samples, and none failed. */
export function controlPlaneAllMissing(result: MetricsResult): boolean {
  return (
    result.failed.length === 0 &&
    CONTROL_PLANE_METRICS.every((metric) => result.missing.includes(metric))
  );
}

/**
 * The charts of a target, in order. metrics-server has only the current CPU and memory,
 * so it gets CPU and Memory without reference lines, and nothing for a PVC.
 */
export function chartsFor(
  target: MetricsTarget,
  source: MetricsSource,
  facts: TargetFacts,
): ChartDef[] {
  const server = source === "metricsServer";
  switch (target.kind) {
    case "cluster":
    case "node": {
      const cluster = target.kind === "cluster";
      const nodes = cluster ? onNodes(known(facts.nodeCount)) : null;
      const cpu = cpuChart(
        words(ofCores(known(facts.allocatableCores)), nodes),
        server ? [] : nodeRefs("cpu"),
      );
      const memory = memoryChart(
        words(ofGibibytes(known(facts.allocatableBytes)), nodes),
        server ? [] : nodeRefs("memory"),
      );
      if (server) return [cpu, memory];
      const capacity = known(facts.podCapacity);
      const podsSub = cluster
        ? capacity === null
          ? "running"
          : `running, capacity ${formatCount(capacity)}`
        : "scheduled on this node";
      return [
        cpu,
        memory,
        podsChart(podsSub),
        diskChart(cluster ? "node root filesystems" : "root filesystem"),
      ];
    }
    case "pod":
    case "workload": {
      const pods = known(facts.podCount);
      const cpuSub =
        target.kind === "pod"
          ? "all containers"
          : pods === null
            ? ""
            : plural(pods, "Pod", "Pods");
      const cpu = cpuChart(cpuSub, server ? [] : podRefs("cpu"));
      const memory = memoryChart(
        "working set",
        server ? [] : podRefs("memory"),
      );
      if (server) return [cpu, memory];
      return [cpu, memory, networkChart(), filesystemChart()];
    }
    case "controlPlane":
      // The panel draws the control plane with controlPlaneCharts, which needs the distribution.
      return [];
    case "pvc":
      return server ? [] : [volumeChart(facts.capacityText)];
  }
}

/** The note a metrics-server panel shows for what it cannot chart (spec D2 §8.3). */
export function serverNote(target: MetricsTarget): string {
  switch (target.kind) {
    case "cluster":
    case "controlPlane":
      return "Pods, disk and control plane history need Prometheus: metrics-server reports only the current CPU and memory.";
    case "node":
      return "Pods and disk history need Prometheus: metrics-server reports only the current CPU and memory.";
    case "pod":
    case "workload":
      return "Network and filesystem charts need Prometheus: metrics-server reports only the current CPU and memory.";
    case "pvc":
      return "Volume usage needs Prometheus: kubelet exports it as kubelet_volume_stats_used_bytes, which metrics-server does not serve.";
  }
}

/** A cluster label as the user typed it: `name="value"`. */
export function labelText(matcher: LabelMatcher): string {
  return `${matcher.name}="${matcher.value}"`;
}

/**
 * The note for an answer with no samples at all under a tenant or a cluster label
 * (spec I17): Mimir answers an unknown tenant with an empty result, not an error.
 * Null when a metric has samples, a query failed, or the provider has neither.
 */
export function noSamplesNote(
  provider: MetricsProvider,
  result: MetricsResult,
): string | null {
  if (provider.kind !== "prometheus" && provider.kind !== "remote") return null;
  const empty =
    result.missing.length > 0 &&
    result.failed.length === 0 &&
    Object.keys(result.series).length === 0;
  if (!empty) return null;
  const { tenant, matcher } = provider;
  if (tenant !== null && matcher !== null) {
    return `No samples for tenant ${tenant} with ${labelText(matcher)}: check the tenant and the cluster label in the cluster settings.`;
  }
  if (tenant !== null) {
    return `No samples for tenant ${tenant}: check the tenant in the cluster settings.`;
  }
  if (matcher !== null) {
    return `No samples with ${labelText(matcher)}: check the cluster label in the cluster settings.`;
  }
  return null;
}
