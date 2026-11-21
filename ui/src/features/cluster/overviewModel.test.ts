import { expect, test } from "vitest";
import type { UsageItem } from "../../ipc/generated/UsageItem";
import type { KubeObject } from "../../kinds/objects";
import type { UsageView } from "../../kinds/usageColumns";
import {
  GIB,
  MIB,
  tnode,
  tpod,
  tregion,
  tsnapshot,
  tzone,
} from "../../test/topology";
import type { KindRow, ListView, WorkloadKind } from "../workloads/counts";
import { WORKLOAD_KINDS } from "../workloads/counts";
import {
  capacityOf,
  type HealthInput,
  healthOf,
  namespaceCaption,
  nodesOf,
  podGroups,
  RECENT_MS,
  recentWarnings,
  topConsumers,
} from "./overviewModel";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function usageView(items: UsageItem[], notServed = false): UsageView {
  return {
    items: new Map(
      items.map((i) => [
        i.namespace === null ? i.name : `${i.namespace}/${i.name}`,
        i,
      ]),
    ),
    notServed,
  };
}

const nodeUsage = (
  name: string,
  cpuCores: number,
  memoryBytes: number,
): UsageItem => ({
  namespace: null,
  name,
  cpuCores,
  memoryBytes,
});

/** Two nodes of 4 cores, 16 GiB and 110 pods: a has 3 pods and requests, b has 2. */
const SNAPSHOT = tsnapshot([
  tregion("eu", [
    tzone("eu-1a", [
      tnode("a", {
        requests: { cpuMillis: 2000, memoryBytes: 8 * GIB, pods: null },
        pods: [
          tpod("shop", "a1"),
          tpod("shop", "a2"),
          tpod("kube-system", "a3"),
        ],
      }),
      tnode("b", {
        requests: { cpuMillis: 1000, memoryBytes: 4 * GIB, pods: null },
        pods: [tpod("shop", "b1"), tpod("shop", "b2")],
      }),
    ]),
  ]),
]);

test("nodes come from every region and zone, in order", () => {
  expect(nodesOf(SNAPSHOT).map((n) => n.name)).toEqual(["a", "b"]);
});

test("capacity sums metrics-server usage against allocatable, with the requests as a note", () => {
  const capacity = capacityOf({
    snapshot: SNAPSHOT,
    error: null,
    nodesForbidden: false,
    usage: usageView([
      nodeUsage("a", 1.5, 6 * GIB),
      nodeUsage("b", 1, 2 * GIB),
    ]),
  });
  expect(capacity?.items).toEqual([
    {
      key: "cpu",
      name: "CPU",
      label: "CPU",
      pct: 31,
      used: "2.5",
      total: "8",
      unit: "cores",
      note: "Requests 38%",
    },
    {
      key: "memory",
      name: "Memory",
      label: "Memory",
      pct: 25,
      used: "8",
      total: "32",
      unit: "GiB",
      note: "Requests 38%",
    },
    {
      key: "pods",
      name: "Pods",
      label: "Pods",
      pct: 2,
      used: "5",
      total: "220",
      unit: "pods",
      note: null,
    },
  ]);
  expect(capacity?.caption).toBe("CPU and memory: usage from metrics-server");
  expect(capacity?.totals).toEqual({ cores: 8, bytes: 32 * GIB, pods: 220 });
});

test("a node without a usage sample counts its requests", () => {
  const capacity = capacityOf({
    snapshot: SNAPSHOT,
    error: null,
    nodesForbidden: false,
    // b has no sample: its 1 core and 4 GiB of requests stand in.
    usage: usageView([nodeUsage("a", 1.5, 6 * GIB)]),
  });
  expect(capacity?.items[0]).toMatchObject({ pct: 31, used: "2.5" });
  expect(capacity?.items[1]).toMatchObject({ pct: 31, used: "10" });
});

test("without metrics.k8s.io the requests stand in, named as requests, with no note", () => {
  const capacity = capacityOf({
    snapshot: SNAPSHOT,
    error: null,
    nodesForbidden: false,
    usage: { items: null, notServed: true },
  });
  expect(capacity?.items.slice(0, 2)).toEqual([
    {
      key: "cpu",
      name: "CPU",
      label: "CPU requests",
      pct: 38,
      used: "3",
      total: "8",
      unit: "cores",
      note: null,
    },
    {
      key: "memory",
      name: "Memory",
      label: "Memory requests",
      pct: 38,
      used: "12",
      total: "32",
      unit: "GiB",
      note: null,
    },
  ]);
  expect(capacity?.caption).toBe(
    "CPU and memory: requests, metrics unavailable",
  );
});

test("memory reads MiB below a 1 GiB total, and pods use thousands commas", () => {
  const small = tsnapshot([
    tregion(null, [
      tzone(null, [
        tnode("tiny", {
          allocatable: { cpuMillis: 500, memoryBytes: 512 * MIB, pods: 1320 },
          requests: { cpuMillis: 100, memoryBytes: 128 * MIB, pods: null },
        }),
      ]),
    ]),
  ]);
  const capacity = capacityOf({
    snapshot: small,
    error: null,
    nodesForbidden: false,
    usage: undefined,
  });
  expect(capacity?.items[1]).toMatchObject({
    used: "128",
    total: "512",
    unit: "MiB",
  });
  expect(capacity?.items[2]).toMatchObject({
    used: "0",
    total: "1,320",
    unit: "pods",
  });
});

test("hidden Pods leave the Pods donut without data and keep the caption", () => {
  const hidden = tsnapshot(SNAPSHOT.regions, true);
  const capacity = capacityOf({
    snapshot: hidden,
    error: null,
    nodesForbidden: false,
    usage: usageView([
      nodeUsage("a", 1.5, 6 * GIB),
      nodeUsage("b", 1, 2 * GIB),
    ]),
  });
  expect(capacity?.items[2]).toMatchObject({
    pct: null,
    used: null,
    total: null,
  });
  expect(capacity?.caption).toBe("CPU and memory: usage from metrics-server");
});

test("forbidden nodes and a failed topology leave every donut without data", () => {
  const none = { pct: null, used: null, total: null, note: null };
  const forbidden = capacityOf({
    snapshot: null,
    error: "nodes is forbidden",
    nodesForbidden: true,
    usage: undefined,
  });
  expect(
    forbidden?.items.map((i) => ({
      pct: i.pct,
      used: i.used,
      total: i.total,
      note: i.note,
    })),
  ).toEqual([none, none, none]);
  expect(forbidden?.caption).toBe(
    "Capacity is not shown: your account may not list nodes, so allocatable cannot be summed.",
  );
  expect(forbidden?.totals).toEqual({ cores: null, bytes: null, pods: null });
  const failed = capacityOf({
    snapshot: null,
    error: "the watch ended.",
    nodesForbidden: false,
    usage: undefined,
  });
  expect(failed?.caption).toBe("Capacity could not be read: the watch ended.");
  expect(
    capacityOf({
      snapshot: null,
      error: null,
      nodesForbidden: false,
      usage: undefined,
    }),
  ).toBeNull();
});

test("a share above 100 % says its true percentage", () => {
  const capacity = capacityOf({
    snapshot: SNAPSHOT,
    error: null,
    nodesForbidden: false,
    usage: usageView([
      nodeUsage("a", 6, 20 * GIB),
      nodeUsage("b", 5, 20 * GIB),
    ]),
  });
  expect(capacity?.items[0].pct).toBe(138);
});

// ---- Health

function obj(
  over: Partial<KubeObject> & { name: string; namespace?: string },
): KubeObject {
  const { name, namespace, ...rest } = over;
  return { metadata: { name, namespace, uid: name }, ...rest } as KubeObject;
}
const pod = (name: string, status: Record<string, unknown>) =>
  obj({ name, namespace: "shop", status });
const waiting = (reason: string, phase = "Running") => ({
  phase,
  containerStatuses: [{ name: "c", state: { waiting: { reason } } }],
});
const warning = (name: string, reason: string, at: Record<string, unknown>) =>
  obj({ name, namespace: "shop", type: "Warning", reason, ...at });

test("Pods group as the Pods list's Status column: Running, Pending, Failed and the rest", () => {
  expect(
    podGroups([
      pod("r", { phase: "Running" }),
      pod("p", { phase: "Pending" }),
      pod("cc", waiting("ContainerCreating", "Pending")),
      pod("crash", waiting("CrashLoopBackOff")),
      pod("f", { phase: "Failed" }),
      pod("done", { phase: "Succeeded" }),
    ]),
  ).toEqual({ total: 6, running: 1, pending: 2, failed: 2 });
});

test("Warning events count when last seen within the hour; the latest names its reason", () => {
  const events = [
    warning("old", "BackOff", { lastTimestamp: ago(RECENT_MS + 1000) }),
    warning("edge", "Unhealthy", { lastTimestamp: ago(RECENT_MS) }),
    warning("new", "FailedMount", { eventTime: ago(120_000) }),
    obj({
      name: "normal",
      namespace: "shop",
      type: "Normal",
      reason: "Pulled",
      lastTimestamp: ago(1000),
    }),
  ];
  const recent = recentWarnings(events, NOW);
  expect(recent.count).toBe(2);
  expect(recent.latest?.metadata.name).toBe("new");
  expect(recent.latestAt).toBe(ago(120_000));
});

test("an event without a readable time is not counted", () => {
  const recent = recentWarnings(
    [
      warning("none", "BackOff", {}),
      warning("bad", "BackOff", { lastTimestamp: "yesterday" }),
    ],
    NOW,
  );
  expect(recent).toEqual({ count: 0, latest: null, latestAt: null });
});

const ready = (items: KubeObject[]): ListView => ({ state: "ready", items });
const counted = (
  kind: WorkloadKind,
  failing: number,
  pending: number,
): KindRow => ({
  kind,
  state: "counted",
  counts: { total: failing + pending + 1, healthy: 1, pending, failing },
});
const WORKLOADS = WORKLOAD_KINDS.slice(1);

function health(over: Partial<HealthInput> = {}) {
  return healthOf({
    clusterId: "c1",
    snapshot: SNAPSHOT,
    topologyError: null,
    nodesForbidden: false,
    pods: ready([pod("r", { phase: "Running" })]),
    workloads: WORKLOADS.map((k) => counted(k, 0, 0)),
    events: ready([]),
    nowMs: NOW,
    ...over,
  });
}

test("four tiles: Nodes ready, Pods, Workloads with problems, Warnings in the last hour", () => {
  const tiles = health();
  expect(
    tiles.map((t) => [t.id, t.label, t.number, t.sub, t.tone, t.to]),
  ).toEqual([
    [
      "nodes",
      "Nodes ready",
      "2 / 2",
      "All ready",
      "ok",
      "/cluster/c1/r/core/nodes",
    ],
    [
      "pods",
      "Pods",
      "1",
      "1 Running · 0 Pending · 0 Failed",
      "ok",
      "/cluster/c1/r/core/pods",
    ],
    [
      "workloads",
      "Workloads with problems",
      "0",
      "All healthy",
      "ok",
      "/cluster/c1/workloads",
    ],
    [
      "events",
      "Warnings in the last hour",
      "0",
      "No Warning events",
      "ok",
      "/cluster/c1/r/core/events",
    ],
  ]);
});

test("NotReady nodes, failing Pods and workloads, and warnings set the tiles' tones", () => {
  const notReady = tsnapshot([
    tregion(null, [
      tzone(null, [
        tnode("a"),
        tnode("b", { ready: "NotReady" }),
        tnode("c", { ready: "Unknown" }),
      ]),
    ]),
  ]);
  const tiles = health({
    snapshot: notReady,
    pods: ready([
      pod("r", { phase: "Running" }),
      pod("p", { phase: "Pending" }),
      pod("crash", waiting("CrashLoopBackOff")),
    ]),
    workloads: [
      counted(WORKLOADS[0], 2, 1),
      ...WORKLOADS.slice(1).map((k) => counted(k, 0, 1)),
    ],
    events: ready([warning("w", "BackOff", { lastTimestamp: ago(150_000) })]),
  });
  expect(tiles.map((t) => [t.number, t.sub, t.tone])).toEqual([
    ["1 / 3", "2 NotReady", "danger"],
    ["3", "1 Running · 1 Pending · 1 Failed", "danger"],
    ["8", "2 failing · 6 pending", "danger"],
    ["1", "Latest: BackOff, 2m30s ago", "warn"],
  ]);
  const pendingOnly = health({
    pods: ready([pod("p", { phase: "Pending" })]),
    workloads: WORKLOADS.map((k) => counted(k, 0, 1)),
  });
  expect(pendingOnly.slice(1, 3).map((t) => t.tone)).toEqual(["warn", "warn"]);
});

test("forbidden nodes disable the Nodes tile; loading and failed lists read a dash", () => {
  const tiles = health({
    snapshot: null,
    nodesForbidden: true,
    pods: { state: "loading" },
    workloads: WORKLOADS.map((kind) => ({
      kind,
      state: "unavailable",
      reason: "no",
    })),
    events: { state: "unavailable", reason: "You may not list Events." },
  });
  expect(tiles.map((t) => [t.number, t.sub, t.tone, t.to === null])).toEqual([
    ["—", "You may not list nodes", "neutral", true],
    ["—", "Loading", "neutral", false],
    ["—", "Could not list workloads", "neutral", false],
    ["—", "Could not list events", "neutral", false],
  ]);
  expect(health({ snapshot: null, topologyError: "boom" })[0]).toMatchObject({
    number: "—",
    sub: "Could not list nodes",
    tone: "neutral",
  });
  expect(health({ snapshot: null })[0]).toMatchObject({
    number: "—",
    sub: "Loading",
  });
  expect(health({ pods: { state: "unavailable", reason: "x" } })[1].sub).toBe(
    "Could not list Pods",
  );
});

test("workloads count the kinds that are there while others are unavailable", () => {
  const tiles = health({
    workloads: [
      counted(WORKLOADS[0], 1, 0),
      ...WORKLOADS.slice(1).map(
        (kind): KindRow => ({ kind, state: "unavailable", reason: "no" }),
      ),
    ],
  });
  expect(tiles[2]).toMatchObject({
    number: "1",
    sub: "1 failing · 0 pending",
    tone: "danger",
  });
  const loading = health({
    workloads: [
      { kind: WORKLOADS[0], state: "loading" },
      ...WORKLOADS.slice(1).map((k) => counted(k, 0, 0)),
    ],
  });
  expect(loading[2]).toMatchObject({ number: "—", sub: "Loading" });
});

test("the namespace caption names one or a few namespaces, and counts many", () => {
  expect(namespaceCaption([])).toBeNull();
  expect(namespaceCaption(["shop"])).toEqual({
    text: "In namespace: shop",
    title: "shop",
  });
  expect(namespaceCaption(["payments", "ingest"])).toEqual({
    text: "In namespaces: payments, ingest",
    title: "payments, ingest",
  });
  const many = [
    "payments-eu",
    "payments-us",
    "ingest-eu",
    "ingest-us",
    "reporting",
  ];
  expect(namespaceCaption(many)).toEqual({
    text: "In 5 namespaces",
    title: many.join(", "),
  });
});

// ---- Top consumers

const podUsage = (
  namespace: string,
  name: string,
  cpuCores: number,
  memoryBytes: number,
): UsageItem => ({
  namespace,
  name,
  cpuCores,
  memoryBytes,
});

const PODS_USAGE = usageView([
  podUsage("shop", "api-0", 0.994, 870 * MIB),
  podUsage("shop", "api-1", 0.5, 300 * MIB),
  podUsage("ingest", "kafka-0", 1.2, 3.4 * GIB),
  podUsage("kube-system", "dns", 0.01, 20 * MIB),
]);

test("top pods and namespaces by CPU, largest first, as the Pods list shows quantities", () => {
  const top = topConsumers(PODS_USAGE, "cpu");
  expect(
    top.pods.map((p) => [p.key, p.name, p.sub, p.amountText, p.openKey]),
  ).toEqual([
    ["ingest/kafka-0", "kafka-0", "ingest", "1.2 cores", "ingest/kafka-0"],
    ["shop/api-0", "api-0", "shop", "994m", "shop/api-0"],
    ["shop/api-1", "api-1", "shop", "500m", "shop/api-1"],
    ["kube-system/dns", "dns", "kube-system", "10m", "kube-system/dns"],
  ]);
  expect(
    top.namespaces.map((n) => [n.key, n.sub, n.amountText, n.openKey]),
  ).toEqual([
    ["shop", "2 pods", "1.5 cores", "/shop"],
    ["ingest", "1 pod", "1.2 cores", "/ingest"],
    ["kube-system", "1 pod", "10m", "/kube-system"],
  ]);
});

test("top consumers by memory, at most five of each, ties by name", () => {
  const top = topConsumers(PODS_USAGE, "memory");
  expect(top.pods.map((p) => p.amountText)).toEqual([
    "3.4Gi",
    "870Mi",
    "300Mi",
    "20Mi",
  ]);
  const many = usageView(
    ["a", "b", "c", "d", "e", "f", "g"].map((n) => podUsage(n, "p", 1, GIB)),
  );
  const tied = topConsumers(many, "cpu");
  expect(tied.pods.map((p) => p.key)).toEqual([
    "a/p",
    "b/p",
    "c/p",
    "d/p",
    "e/p",
  ]);
  expect(tied.namespaces).toHaveLength(5);
});

test("no usage reads as no rows", () => {
  expect(topConsumers(undefined, "cpu")).toEqual({ namespaces: [], pods: [] });
  expect(topConsumers({ items: null, notServed: true }, "memory")).toEqual({
    namespaces: [],
    pods: [],
  });
});
