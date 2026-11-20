import { expect, test } from "vitest";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import type { TopologyNode } from "../../ipc/generated/TopologyNode";
import { usageItem } from "../../test/metrics";
import {
  GIB,
  MIB,
  tnode,
  tpod,
  tregion,
  tsnapshot,
  tzone,
} from "../../test/topology";
import {
  clusterLabel,
  conditionBadges,
  countText,
  cpuUsage,
  filterRegions,
  mapNamespaces,
  memoryUsage,
  namespaceGroups,
  nodeMatches,
  nodeTotal,
  podCountText,
  podKey,
  podTip,
  regionLabel,
  resolveActive,
  sourceNote,
  taintLine,
  usageServed,
  zoneLabel,
} from "./model";

const A = tnode("worker-1", {
  labels: { team: "Payments", "topology.kubernetes.io/zone": "eu-1a" },
  pods: [tpod("shop", "web-1"), tpod("db", "pg-0")],
});
const B = tnode("worker-2", { pods: [tpod("shop", "web-2")] });
const C = tnode("edge-1");
const REGIONS = [
  tregion("eu", [tzone("eu-1a", [A, B]), tzone("eu-1b", [C])]),
  tregion(null, [tzone(null, [tnode("lab-1", { pods: [tpod("lab", "x")] })])]),
];

function connected(distribution: string, version: string): ConnectionState {
  return {
    status: "connected",
    info: {
      version,
      distribution,
      nodeCount: null,
      namespaces: [],
      namespacesRestricted: false,
      isAdmin: false,
    },
  };
}

test("a node matches by its name or a label value, ignoring case", () => {
  expect(nodeMatches(A, "")).toBe(true);
  expect(nodeMatches(A, "  ")).toBe(true);
  expect(nodeMatches(A, "WORKER-1")).toBe(true);
  expect(nodeMatches(A, "pay")).toBe(true);
  expect(nodeMatches(A, "eu-1A")).toBe(true);
  expect(nodeMatches(A, "team")).toBe(false);
  expect(nodeMatches(B, "pay")).toBe(false);
});

test("a filter keeps the matching nodes and recounts the regions; no filter keeps the same array", () => {
  expect(filterRegions(REGIONS, "")).toBe(REGIONS);
  const shown = filterRegions(REGIONS, "worker");
  expect(
    shown.map((r) => [
      r.name,
      r.nodeCount,
      r.podCount,
      r.zones.map((z) => [z.name, z.nodes.map((n) => n.name)]),
    ]),
  ).toEqual([["eu", 2, 3, [["eu-1a", ["worker-1", "worker-2"]]]]]);
  expect(filterRegions(REGIONS, "nothing")).toEqual([]);
  expect(nodeTotal(REGIONS)).toBe(4);
  expect(nodeTotal(shown)).toBe(2);
});

test("the count reads the total, or N of M while a filter is on", () => {
  expect(countText(4, 4, false)).toBe("4");
  expect(countText(2, 4, true)).toBe("2 of 4");
  expect(countText(0, 4, true)).toBe("0 of 4");
});

test("the highlight menu lists each namespace of the whole snapshot once, sorted", () => {
  expect(mapNamespaces(tsnapshot(REGIONS))).toEqual(["db", "lab", "shop"]);
  expect(mapNamespaces(tsnapshot([]))).toEqual([]);
});

test("the cluster label adds the distribution and release while connected, as the switcher names them", () => {
  expect(clusterLabel("prod-eu-west", connected("EKS", "v1.34.2"))).toBe(
    "prod-eu-west · EKS v1.34.2",
  );
  expect(clusterLabel("lab", connected(" ", "v1.33.1"))).toBe(
    "lab · Kubernetes v1.33.1",
  );
  expect(clusterLabel("edge", connected("rke2", "v1.37.0+rke2r1"))).toBe(
    "edge · rke2 v1.37.0",
  );
  expect(clusterLabel("eks", connected("EKS", ""))).toBe("eks · EKS");
  expect(clusterLabel("prod", { status: "disconnected" })).toBe("prod");
  expect(clusterLabel("prod", undefined)).toBe("prod");
});

test("group labels name their kind, read in the singular for one, and drop the pods while they are hidden", () => {
  const [eu, none] = REGIONS;
  if (!eu || !none) throw new Error("no regions");
  expect(regionLabel(eu, false)).toBe("eu · Region · 3 nodes · 3 pods");
  expect(regionLabel(none, false)).toBe("No region · 1 node · 1 pod");
  expect(regionLabel(eu, true)).toBe("eu · Region · 3 nodes");
  expect(eu.zones.map(zoneLabel)).toEqual([
    "eu-1a · Zone · 2 nodes",
    "eu-1b · Zone · 1 node",
  ]);
  expect(none.zones.map(zoneLabel)).toEqual(["No zone · 1 node"]);
});

test("condition badges put NotReady first, then the conditions in nodeConditions' tones", () => {
  expect(conditionBadges(tnode("ok"))).toEqual([]);
  expect(
    conditionBadges(
      tnode("bad", {
        ready: "NotReady",
        conditions: ["NetworkUnavailable", "MemoryPressure", "PIDPressure"],
      }),
    ),
  ).toEqual([
    { label: "NotReady", tone: "danger" },
    { label: "NetworkUnavailable", tone: "danger" },
    { label: "MemoryPressure", tone: "warn" },
    { label: "PIDPressure", tone: "warn" },
  ]);
  expect(conditionBadges(tnode("unknown", { ready: "Unknown" }))).toEqual([]);
});

test("a taint reads key=value:Effect, or key:Effect without a value", () => {
  expect(
    taintLine({ key: "dedicated", value: "db", effect: "NoSchedule" }),
  ).toBe("dedicated=db:NoSchedule");
  expect(taintLine({ key: "gpu", value: null, effect: "NoExecute" })).toBe(
    "gpu:NoExecute",
  );
});

test("node usage counts as served only while the polling has nodes", () => {
  const item = usageItem({ name: "worker-1", namespace: null });
  expect(usageServed(undefined)).toBe(false);
  expect(usageServed({ items: null, notServed: false })).toBe(false);
  expect(usageServed({ items: new Map(), notServed: false })).toBe(false);
  expect(
    usageServed({ items: new Map([["worker-1", item]]), notServed: true }),
  ).toBe(false);
  expect(
    usageServed({ items: new Map([["worker-1", item]]), notServed: false }),
  ).toBe(true);
  expect(sourceNote(true)).toBe("CPU and memory: usage from metrics-server");
  expect(sourceNote(false)).toBe(
    "CPU and memory: requests, metrics unavailable",
  );
});

test("donut figures read usage, else requests, against allocatable", () => {
  const node = tnode("n", {
    requests: {
      cpuMillis: 2100,
      memoryBytes: Math.round(11.8 * GIB),
      pods: null,
    },
  });
  expect(cpuUsage(node, undefined)).toEqual({
    name: "CPU",
    pct: 53,
    used: "2.1",
    total: "4",
    unit: "cores",
  });
  expect(memoryUsage(node, undefined)).toEqual({
    name: "Memory",
    pct: 74,
    used: "11.8",
    total: "16",
    unit: "GiB",
  });
  const usage = usageItem({
    name: "n",
    namespace: null,
    cpuCores: 3.4,
    memoryBytes: 15.5 * GIB,
  });
  expect(cpuUsage(node, usage)).toMatchObject({ pct: 85, used: "3.4" });
  expect(memoryUsage(node, usage)).toMatchObject({ pct: 97, used: "15.5" });
  const small = tnode("small", {
    allocatable: { cpuMillis: 4000, memoryBytes: 512 * MIB, pods: 110 },
    requests: { cpuMillis: 6000, memoryBytes: 384 * MIB, pods: null },
  });
  expect(memoryUsage(small, undefined)).toEqual({
    name: "Memory",
    pct: 75,
    used: "384",
    total: "512",
    unit: "MiB",
  });
  expect(cpuUsage(small, undefined)).toMatchObject({
    pct: 150,
    used: "6",
    total: "4",
  });
});

test("a figure without allocatable, with allocatable 0 or without a used amount has no share (RF1)", () => {
  const cases: TopologyNode[] = [
    tnode("none", {
      allocatable: { cpuMillis: null, memoryBytes: null, pods: null },
    }),
    tnode("zero", { allocatable: { cpuMillis: 0, memoryBytes: 0, pods: 0 } }),
    tnode("nan", {
      allocatable: {
        cpuMillis: Number.NaN,
        memoryBytes: Number.NaN,
        pods: null,
      },
    }),
    tnode("hidden", {
      requests: { cpuMillis: null, memoryBytes: null, pods: null },
    }),
  ];
  for (const node of cases) {
    for (const figure of [
      cpuUsage(node, undefined),
      memoryUsage(node, undefined),
    ]) {
      expect([
        node.name,
        figure.name,
        figure.pct,
        figure.used,
        figure.total,
      ]).toEqual([node.name, figure.name, null, null, null]);
    }
  }
  const broken = usageItem({
    name: "x",
    namespace: null,
    cpuCores: Number.NaN,
    memoryBytes: Number.POSITIVE_INFINITY,
  });
  for (const figure of [
    cpuUsage(tnode("x"), broken),
    memoryUsage(tnode("x"), broken),
  ]) {
    expect([figure.pct, figure.used, figure.total]).toEqual([null, null, null]);
  }
});

test("the pod count reads N / P pods, or N pods without a limit, singular for one", () => {
  expect(podCountText(A)).toBe("2 / 110 pods");
  const open = { cpuMillis: 4000, memoryBytes: 16 * GIB, pods: null };
  expect(podCountText(tnode("a", { allocatable: open }))).toBe("0 pods");
  expect(podCountText({ ...B, allocatable: open })).toBe("1 pod");
});

test("squares group by namespace, namespaces sorted, then by name", () => {
  const pods = [
    tpod("shop", "web-2"),
    tpod("db", "pg-0"),
    tpod("shop", "web-1", "Failed", "CrashLoopBackOff"),
  ];
  expect(
    namespaceGroups(pods).map((g) => [g.namespace, g.pods.map(podKey)]),
  ).toEqual([
    ["db", ["db/pg-0"]],
    ["shop", ["shop/web-1", "shop/web-2"]],
  ]);
  expect(podTip(pods[2] ?? tpod("x", "y"))).toBe(
    "shop/web-1 · CrashLoopBackOff",
  );
});

test("the active square follows its pod, else keeps its place, clamped to the last (RF2)", () => {
  const keys = ["a/1", "a/2", "a/3"];
  const active = { key: "a/2", index: 1 };
  expect(resolveActive(null, keys)).toBeNull();
  expect(resolveActive(active, keys)).toBe(active);
  expect(resolveActive(active, ["a/0", "a/1", "a/2", "a/3"])).toEqual({
    key: "a/2",
    index: 2,
  });
  expect(resolveActive(active, ["a/1", "a/3"])).toEqual({
    key: "a/3",
    index: 1,
  });
  expect(resolveActive({ key: "a/3", index: 2 }, ["a/1"])).toEqual({
    key: "a/1",
    index: 0,
  });
  expect(resolveActive(active, [])).toBeNull();
});
