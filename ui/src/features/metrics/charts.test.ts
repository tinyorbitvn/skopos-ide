import { expect, test } from "vitest";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import {
  metricsResult,
  metricsServer,
  points,
  prometheus,
  remote,
} from "../../test/metrics";
import {
  type ChartDef,
  CONTROL_PLANE,
  chartsFor,
  controlPlaneAllMissing,
  controlPlaneCharts,
  controlPlaneMissingNote,
  controlPlaneNote,
  etcdDatabaseSub,
  factsFromResult,
  labelText,
  lastValue,
  mergeFacts,
  NO_FACTS,
  noSamplesNote,
  plural,
  RANGE_PERIOD,
  serverNote,
  type TargetFacts,
} from "./charts";

const GIB = 2 ** 30;
const CLUSTER: MetricsTarget = { kind: "cluster" };
const NODE: MetricsTarget = { kind: "node", name: "worker" };
const POD: MetricsTarget = { kind: "pod", namespace: "shop", name: "web-1" };
const WORKLOAD: MetricsTarget = {
  kind: "workload",
  namespace: "shop",
  name: "web",
  workloadKind: "Deployment",
};
const PVC: MetricsTarget = { kind: "pvc", namespace: "shop", name: "data" };
const FACTS: TargetFacts = {
  allocatableCores: 4,
  allocatableBytes: 16 * GIB,
  nodeCount: 2,
  podCapacity: 220,
  podCount: 3,
  capacityText: "10 GiB",
};

/** stem, title, sub, unit, main, mirror and reference lines as metric:name pairs. */
function shape(charts: ChartDef[]): string[][] {
  return charts.map((c) => [
    c.stem,
    c.title,
    c.sub,
    c.unit,
    `${c.main.metric}:${c.main.name}`,
    c.mirror ? `${c.mirror.metric}:${c.mirror.name}` : "-",
    c.refs.map((r) => `${r.metric}:${r.name}`).join(" "),
  ]);
}

function subs(target: MetricsTarget, facts: Partial<TargetFacts>): string[] {
  return chartsFor(target, "prometheus", { ...NO_FACTS, ...facts }).map(
    (c) => c.sub,
  );
}

test("the cluster has CPU, Memory, Pods and Disk under Prometheus", () => {
  expect(shape(chartsFor(CLUSTER, "prometheus", FACTS))).toEqual([
    [
      "cpu",
      "CPU",
      "of 4 cores on 2 nodes",
      "cores",
      "cpuUsage:Usage",
      "-",
      "cpuRequests:Requests cpuLimits:Limits",
    ],
    [
      "memory",
      "Memory",
      "of 16 GiB on 2 nodes",
      "bytes",
      "memoryUsage:Working set",
      "-",
      "memoryRequests:Requests memoryLimits:Limits",
    ],
    [
      "pods",
      "Pods",
      "running, capacity 220",
      "count",
      "podUsage:Running",
      "-",
      "podCapacity:Capacity",
    ],
    [
      "disk",
      "Disk",
      "node root filesystems",
      "bytes",
      "diskUsage:Used",
      "-",
      "diskCapacity:Capacity",
    ],
  ]);
});

test("a node has the same charts with its own subs", () => {
  expect(shape(chartsFor(NODE, "prometheus", FACTS))).toEqual([
    [
      "cpu",
      "CPU",
      "of 4 cores",
      "cores",
      "cpuUsage:Usage",
      "-",
      "cpuRequests:Requests cpuLimits:Limits",
    ],
    [
      "memory",
      "Memory",
      "of 16 GiB",
      "bytes",
      "memoryUsage:Working set",
      "-",
      "memoryRequests:Requests memoryLimits:Limits",
    ],
    [
      "pods",
      "Pods",
      "scheduled on this node",
      "count",
      "podUsage:Running",
      "-",
      "podCapacity:Capacity",
    ],
    [
      "disk",
      "Disk",
      "root filesystem",
      "bytes",
      "diskUsage:Used",
      "-",
      "diskCapacity:Capacity",
    ],
  ]);
});

test("a Pod has CPU, Memory, a mirrored Network and Filesystem", () => {
  expect(shape(chartsFor(POD, "prometheus", FACTS))).toEqual([
    [
      "cpu",
      "CPU",
      "all containers",
      "cores",
      "cpuUsage:Usage",
      "-",
      "cpuRequests:Request cpuLimits:Limit",
    ],
    [
      "memory",
      "Memory",
      "working set",
      "bytes",
      "memoryUsage:Working set",
      "-",
      "memoryRequests:Request memoryLimits:Limit",
    ],
    [
      "network",
      "Network",
      "received above, sent below",
      "bytesPerSecond",
      "networkReceive:Received",
      "networkTransmit:Sent",
      "",
    ],
    [
      "filesystem",
      "Filesystem",
      "container writable layers",
      "bytes",
      "fsUsage:Used",
      "-",
      "",
    ],
  ]);
});

test("a workload has the Pod charts, with its Pod count as the CPU sub", () => {
  const charts = chartsFor(WORKLOAD, "prometheus", FACTS);
  expect(shape(charts).slice(1)).toEqual(
    shape(chartsFor(POD, "prometheus", FACTS)).slice(1),
  );
  expect(charts[0].sub).toBe("3 Pods");
  expect([
    subs(WORKLOAD, { podCount: 1 })[0],
    subs(WORKLOAD, { podCount: 0 })[0],
    subs(WORKLOAD, {})[0],
  ]).toEqual(["1 Pod", "0 Pods", ""]);
});

test("a PVC has Volume usage against its capacity", () => {
  expect(shape(chartsFor(PVC, "prometheus", FACTS))).toEqual([
    [
      "volume",
      "Volume usage",
      "capacity 10 GiB",
      "bytes",
      "diskUsage:Used",
      "-",
      "diskCapacity:Capacity",
    ],
  ]);
  expect(subs(PVC, {})).toEqual([""]);
});

test("subs drop what is not known and use the singular for one", () => {
  expect(subs(CLUSTER, {})).toEqual([
    "",
    "",
    "running",
    "node root filesystems",
  ]);
  expect(subs(CLUSTER, { nodeCount: 1, allocatableCores: 1 })).toEqual([
    "of 1 core on 1 node",
    "on 1 node",
    "running",
    "node root filesystems",
  ]);
  expect(
    subs(CLUSTER, { allocatableCores: 0.5, allocatableBytes: 15.62 * GIB }),
  ).toEqual([
    "of 0.5 cores",
    "of 15.6 GiB",
    "running",
    "node root filesystems",
  ]);
  expect(subs(NODE, { nodeCount: 3 }).slice(0, 2)).toEqual(["", ""]);
  expect(subs(CLUSTER, { allocatableCores: Number.NaN })[0]).toBe("");
});

test("metrics-server gets only CPU and Memory, without reference lines", () => {
  for (const target of [CLUSTER, NODE, POD, WORKLOAD]) {
    const server = chartsFor(target, "metricsServer", FACTS);
    const prometheus = chartsFor(target, "prometheus", FACTS).slice(0, 2);
    expect(server).toEqual(prometheus.map((c) => ({ ...c, refs: [] })));
  }
  expect(chartsFor(CLUSTER, "metricsServer", FACTS).map((c) => c.sub)).toEqual([
    "of 4 cores on 2 nodes",
    "of 16 GiB on 2 nodes",
  ]);
  expect(chartsFor(PVC, "metricsServer", FACTS)).toEqual([]);
});

test("the last usable point of a series", () => {
  expect([
    lastValue(undefined),
    lastValue([]),
    lastValue(points([1, 2, 3])),
    lastValue(points([1, 2, Number.NaN])),
    lastValue(points([1, -1])),
    lastValue(points([0])),
  ]).toEqual([null, null, 3, 2, 1, 0]);
});

test("a Prometheus answer gives allocatable CPU and memory and the capacities", () => {
  const result = metricsResult({
    cpuAllocatable: points([4, 4]),
    memoryAllocatable: points([16 * GIB]),
    podCapacity: points([110, 220]),
    diskCapacity: points([10 * GIB]),
    cpuUsage: points([1]),
  });

  expect(factsFromResult(result)).toEqual({
    allocatableCores: 4,
    allocatableBytes: 16 * GIB,
    podCapacity: 220,
    capacityText: "10 GiB",
  });
  expect(factsFromResult(null)).toEqual({});
  expect(
    factsFromResult(
      metricsResult(
        { cpuAllocatable: points([4]), podCapacity: points([Number.NaN]) },
        { missing: ["cpuAllocatable"] },
      ),
    ),
  ).toEqual({});
});

test("the caller's facts win, and the answer fills the rest", () => {
  expect(
    mergeFacts(
      { ...NO_FACTS, nodeCount: 2, allocatableCores: 8 },
      { allocatableCores: 4, allocatableBytes: 16 * GIB },
    ),
  ).toEqual({
    ...NO_FACTS,
    nodeCount: 2,
    allocatableCores: 8,
    allocatableBytes: 16 * GIB,
  });
});

test("the metrics-server note names what needs Prometheus", () => {
  expect([CLUSTER, NODE, POD, WORKLOAD, PVC].map((t) => serverNote(t))).toEqual(
    [
      "Pods, disk and control plane history need Prometheus: metrics-server reports only the current CPU and memory.",
      "Pods and disk history need Prometheus: metrics-server reports only the current CPU and memory.",
      "Network and filesystem charts need Prometheus: metrics-server reports only the current CPU and memory.",
      "Network and filesystem charts need Prometheus: metrics-server reports only the current CPU and memory.",
      "Volume usage needs Prometheus: kubelet exports it as kubelet_volume_stats_used_bytes, which metrics-server does not serve.",
    ],
  );
});

test("periods and plurals", () => {
  expect(RANGE_PERIOD).toEqual({
    "1h": "1 hour",
    "6h": "6 hours",
    "24h": "24 hours",
    "7d": "7 days",
  });
  expect([plural(1, "Pod", "Pods"), plural(2, "Pod", "Pods")]).toEqual([
    "1 Pod",
    "2 Pods",
  ]);
});

test("the no-samples note names the tenant and the label, only when nothing answered and nothing failed", () => {
  const empty = metricsResult({}, { missing: ["cpuUsage", "memoryUsage"] });
  const label = { name: "cluster", value: "prod" };
  expect(labelText(label)).toBe('cluster="prod"');
  expect(
    noSamplesNote(prometheus({ tenant: "team-a", matcher: label }), empty),
  ).toBe(
    'No samples for tenant team-a with cluster="prod": check the tenant and the cluster label in the cluster settings.',
  );
  expect(noSamplesNote(prometheus({ tenant: "team-a" }), empty)).toBe(
    "No samples for tenant team-a: check the tenant in the cluster settings.",
  );
  expect(noSamplesNote(prometheus({ matcher: label }), empty)).toBe(
    'No samples with cluster="prod": check the cluster label in the cluster settings.',
  );
  expect(noSamplesNote(prometheus(), empty)).toBeNull();
  expect(noSamplesNote(metricsServer(), empty)).toBeNull();
  expect(noSamplesNote(remote({ tenant: "team-a" }), empty)).toBe(
    "No samples for tenant team-a: check the tenant in the cluster settings.",
  );
  expect(noSamplesNote(remote(), empty)).toBeNull();

  const mimir = prometheus({ tenant: "team-a", matcher: label });
  expect(
    noSamplesNote(
      mimir,
      metricsResult({ cpuUsage: points([1]) }, { missing: ["memoryUsage"] }),
    ),
  ).toBeNull();
  expect(
    noSamplesNote(
      mimir,
      metricsResult({}, { missing: ["memoryUsage"], failed: ["cpuUsage"] }),
    ),
  ).toBeNull();
  expect(noSamplesNote(mimir, metricsResult({}))).toBeNull();
});

test("the control plane has four charts from the API server's own metrics", () => {
  const defs = controlPlaneCharts("EKS");
  expect(defs.map((d) => [d.stem, d.title, d.sub, d.unit])).toEqual([
    ["api-requests", "API requests", "all verbs", "requestsPerSecond"],
    ["api-latency", "API latency", "p99, without WATCH", "seconds"],
    [
      "etcd-latency",
      "etcd latency",
      "p99 of the API server's requests",
      "seconds",
    ],
    [
      "etcd-database",
      "etcd database",
      "8 GiB on standard control planes",
      "bytes",
    ],
  ]);
  expect(defs[0].main).toEqual({ metric: "apiRequests", name: "Requests" });
  expect(defs[0].refs).toEqual([{ metric: "apiErrors", name: "5xx errors" }]);
  expect(defs.map((d) => d.main.metric)).toEqual([
    "apiRequests",
    "apiLatencyP99",
    "etcdLatencyP99",
    "etcdDbSize",
  ]);
  expect(CONTROL_PLANE).toEqual({ kind: "controlPlane" });
});

test("the etcd database sub-line follows the distribution", () => {
  expect(etcdDatabaseSub("EKS")).toBe("8 GiB on standard control planes");
  for (const d of ["kind", "minikube", "k3s", "rke2", "Kubernetes"]) {
    expect([d, etcdDatabaseSub(d)]).toEqual([
      d,
      "etcd's default quota is 2 GiB",
    ]);
  }
  for (const d of ["GKE", "AKS"]) {
    expect([d, etcdDatabaseSub(d)]).toEqual([d, "size on disk"]);
  }
});

test("an unknown distribution gets the generic wording", () => {
  for (const d of ["OpenShift", "", "acme-k8s"]) {
    expect([d, etcdDatabaseSub(d), controlPlaneNote(d)]).toEqual([
      d,
      "size on disk",
      "From the API server's own metrics, etcd as the API server sees it.",
    ]);
  }
});

test("on EKS, GKE and AKS the source caption says that the provider runs etcd", () => {
  expect(controlPlaneNote("AKS")).toBe(
    "From the API server's own metrics: AKS runs etcd, so etcd is read as the API server sees it.",
  );
  expect(controlPlaneNote("kind")).toBe(
    "From the API server's own metrics, etcd as the API server sees it.",
  );
});

test("the all-missing note names the metric, and the cluster label when there is one", () => {
  const tail =
    ". kube-prometheus-stack scrapes the API server by default; another Prometheus needs a job for the kubernetes Service's endpoints.";
  expect(controlPlaneMissingNote(null)).toBe(
    `No API server metrics in this Prometheus: there are no samples of apiserver_request_total${tail}`,
  );
  expect(controlPlaneMissingNote({ name: "cluster", value: "x" })).toBe(
    `No API server metrics in this Prometheus: there are no samples of apiserver_request_total with cluster="x"${tail}`,
  );
});

test("the control plane is all missing only when all five metrics are and none failed", () => {
  const all = [
    "apiRequests",
    "apiErrors",
    "apiLatencyP99",
    "etcdLatencyP99",
    "etcdDbSize",
  ] as const;
  expect(controlPlaneAllMissing(metricsResult({}, { missing: [...all] }))).toBe(
    true,
  );
  expect(
    controlPlaneAllMissing(
      metricsResult(
        { apiRequests: points([1]) },
        { missing: [...all.slice(1)] },
      ),
    ),
  ).toBe(false);
  expect(
    controlPlaneAllMissing(
      metricsResult(
        {},
        { missing: [...all.slice(1)], failed: ["apiRequests"] },
      ),
    ),
  ).toBe(false);
});
