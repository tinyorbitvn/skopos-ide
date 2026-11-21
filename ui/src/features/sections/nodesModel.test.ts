import { expect, test } from "vitest";
import {
  Activity,
  CirclePause,
  CircleX,
  ShieldCheck,
} from "../../design/icons";
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
import { capacityOf } from "../cluster/overviewModel";
import {
  BUSIEST_LIMIT,
  busiestNodes,
  type DonutValue,
  donutCaption,
  donutValue,
  loadingStateTiles,
  NO_ZONE,
  nodeStateTiles,
  nodesError,
  versionTables,
  type ZoneRow,
  zoneRows,
} from "./nodesModel";

/** Node usage as `useListUsage` keys it: by the node's name. */
function usage(
  items: { name: string; cores: number; bytes: number }[],
): UsageView {
  return {
    items: new Map(
      items.map((i): [string, UsageItem] => [
        i.name,
        {
          namespace: null,
          name: i.name,
          cpuCores: i.cores,
          memoryBytes: i.bytes,
        },
      ]),
    ),
    notServed: false,
  };
}
const NOT_SERVED: UsageView = { items: null, notServed: true };
const NODES_LIST = "/cluster/c1/r/core/nodes";

test("the state tiles count Ready, NotReady, Cordoned and pressured nodes, and each opens the Nodes list", () => {
  const snapshot = tsnapshot([
    tregion("eu", [
      tzone("eu-1a", [
        // Cordoned and Ready: it counts in both tiles.
        tnode("worker-10", { unschedulable: true }),
        tnode("worker-2", {
          ready: "NotReady",
          conditions: ["MemoryPressure", "DiskPressure", "NetworkUnavailable"],
        }),
      ]),
      tzone("eu-1b", [
        tnode("worker-1", { ready: "Unknown" }),
        tnode("worker-3"),
      ]),
    ]),
  ]);
  const tiles = nodeStateTiles(snapshot, "c1");
  expect(tiles.map((t) => [t.id, t.label, t.icon, t.to])).toEqual([
    ["ready", "Ready", ShieldCheck, NODES_LIST],
    ["not-ready", "NotReady", CircleX, NODES_LIST],
    ["cordoned", "Cordoned", CirclePause, NODES_LIST],
    ["pressure", "Under pressure", Activity, NODES_LIST],
  ]);
  expect(tiles.map((t) => [t.number, t.sub, t.tone])).toEqual([
    ["2", "Of 4 nodes", "ok"],
    // Unknown counts as NotReady; names sort naturally.
    ["2", "worker-1, worker-2", "danger"],
    ["1", "worker-10", "warn"],
    // NetworkUnavailable is no pressure.
    ["1", "worker-2: MemoryPressure, DiskPressure", "warn"],
  ]);
});

test("with every node healthy, NotReady, Cordoned and Under pressure read None in the ok tone", () => {
  const tiles = nodeStateTiles(
    tsnapshot([tregion(null, [tzone(null, [tnode("solo")])])]),
    "c1",
  );
  expect(tiles.map((t) => [t.number, t.sub, t.tone])).toEqual([
    ["1", "Of 1 node", "ok"],
    ["0", "None", "ok"],
    ["0", "None", "ok"],
    ["0", "None", "ok"],
  ]);
});

test("several nodes under pressure read their names, two of them and how many more", () => {
  const nodes = ["p-10", "p-2", "p-1", "p-3"].map((name) =>
    tnode(name, { conditions: ["PIDPressure"] }),
  );
  const [, , , pressure] = nodeStateTiles(
    tsnapshot([tregion(null, [tzone(null, nodes)])]),
    "c1",
  );
  expect([pressure.number, pressure.sub, pressure.tone]).toEqual([
    "4",
    "p-1, p-2 and 2 more",
    "warn",
  ]);
});

test("while the topology loads, the state tiles read a dash and Loading and still open the Nodes list", () => {
  expect(
    loadingStateTiles("c1").map((t) => [t.id, t.number, t.sub, t.tone, t.to]),
  ).toEqual([
    ["ready", "—", "Loading", "neutral", NODES_LIST],
    ["not-ready", "—", "Loading", "neutral", NODES_LIST],
    ["cordoned", "—", "Loading", "neutral", NODES_LIST],
    ["pressure", "—", "Loading", "neutral", NODES_LIST],
  ]);
});

/** worker-03 as spec §3.3 shows it; node-2 and node-10 tie; unknown and quiet are left out. */
const BUSY = tsnapshot([
  tregion("eu-west", [
    tzone("eu-west-1c", [
      tnode("worker-03", {
        roles: ["worker"],
        allocatable: { cpuMillis: 15_800, memoryBytes: 64 * GIB, pods: 110 },
      }),
      tnode("node-10", { roles: ["worker"] }),
      tnode("node-2", { roles: ["worker"] }),
    ]),
  ]),
  tregion(null, [
    tzone(null, [
      tnode("node-3", { roles: ["control-plane", "worker"] }),
      tnode("node-4"),
      tnode("node-5"),
      tnode("unknown", {
        allocatable: { cpuMillis: null, memoryBytes: null, pods: null },
      }),
      tnode("quiet"),
    ]),
  ]),
]);
const BUSY_USAGE = usage([
  { name: "worker-03", cores: 13.3, bytes: 60.5 * GIB },
  { name: "node-10", cores: 2, bytes: 8 * GIB },
  { name: "node-2", cores: 2, bytes: 8 * GIB },
  { name: "node-3", cores: 1, bytes: 2 * GIB },
  { name: "node-4", cores: 0.5, bytes: 1 * GIB },
  { name: "node-5", cores: 0.2, bytes: 0.5 * GIB },
  { name: "unknown", cores: 3, bytes: 3 * GIB },
]);

test("busiest nodes rank by the share of their own allocatable, then by name, five at most", () => {
  expect(BUSIEST_LIMIT).toBe(5);
  const rows = busiestNodes(BUSY, BUSY_USAGE, "cpu");
  // node-5 is sixth; unknown has no allocatable and quiet no sample.
  expect(rows.map((r) => r.key)).toEqual([
    "worker-03",
    "node-2",
    "node-10",
    "node-3",
    "node-4",
  ]);
  expect(rows[0]).toEqual({
    key: "worker-03",
    name: "worker-03",
    sub: "worker · eu-west-1c",
    amount: 13.3,
    amountText: "13.3 cores",
    own: { pct: 84, label: "worker-03 CPU 84%, 13.3 of 15.8 cores" },
  });
  expect(rows[3]).toMatchObject({
    sub: "control-plane, worker",
    amountText: "1 cores",
    own: { pct: 25, label: "node-3 CPU 25%, 1 of 4 cores" },
  });
  // Neither a role nor a zone: no sub-line.
  expect(rows[4]?.sub).toBe("");
  expect(busiestNodes(BUSY, BUSY_USAGE, "cpu", 2).map((r) => r.key)).toEqual([
    "worker-03",
    "node-2",
  ]);
});

test("busiest nodes by memory read GiB, or MiB on a node under 1 GiB", () => {
  const [top] = busiestNodes(BUSY, BUSY_USAGE, "memory");
  expect(top).toEqual({
    key: "worker-03",
    name: "worker-03",
    sub: "worker · eu-west-1c",
    amount: 60.5 * GIB,
    amountText: "60.5 GiB",
    own: { pct: 95, label: "worker-03 Memory 95%, 60.5 of 64 GiB" },
  });
  const small = tsnapshot([
    tregion(null, [
      tzone(null, [
        tnode("small", {
          allocatable: { cpuMillis: 1000, memoryBytes: 512 * MIB, pods: 10 },
        }),
      ]),
    ]),
  ]);
  expect(
    busiestNodes(
      small,
      usage([{ name: "small", cores: 0.1, bytes: 256 * MIB }]),
      "memory",
    ),
  ).toEqual([
    {
      key: "small",
      name: "small",
      sub: "",
      amount: 256 * MIB,
      amountText: "256 MiB",
      own: { pct: 50, label: "small Memory 50%, 256 of 512 MiB" },
    },
  ]);
});

test("without node usage there is no busiest node", () => {
  expect(busiestNodes(BUSY, undefined, "cpu")).toEqual([]);
  expect(busiestNodes(BUSY, NOT_SERVED, "cpu")).toEqual([]);
  expect(
    busiestNodes(BUSY, { items: new Map(), notServed: false }, "memory"),
  ).toEqual([]);
});

/**
 * Two zones of region eu, a node of eu without a zone, and one without a region or a zone;
 * node b has no sample, so its requests count, as Capacity reads it.
 */
const ZONED = tsnapshot([
  tregion("eu", [
    tzone("zone-10", [tnode("a", { pods: [tpod("shop", "a-0")] })]),
    tzone(null, [
      tnode("b", {
        requests: { cpuMillis: 1000, memoryBytes: 3 * GIB, pods: null },
        pods: [tpod("shop", "b-0"), tpod("shop", "b-1")],
      }),
    ]),
    tzone("zone-2", [tnode("c"), tnode("d")]),
  ]),
  tregion(null, [tzone(null, [tnode("e")])]),
]);
const ZONED_USAGE = usage([
  { name: "a", cores: 1, bytes: 2 * GIB },
  { name: "c", cores: 3, bytes: 4 * GIB },
  { name: "d", cores: 1, bytes: 4 * GIB },
  { name: "e", cores: 1, bytes: 2 * GIB },
]);

test("nodes without a zone sit last as No zone", () => {
  const rows = zoneRows(ZONED, ZONED_USAGE);
  expect(NO_ZONE).toBe("No zone");
  expect(rows.map((r) => [r.zone, r.region, r.nodes])).toEqual([
    ["zone-2", "eu", 2],
    ["zone-10", "eu", 1],
    ["No zone", "eu", 1],
    ["No zone", "", 1],
  ]);
  expect(rows[0]?.cpu).toEqual({
    pct: 50,
    used: "4",
    total: "8",
    unit: "cores",
    label: "zone-2 CPU 50%, 4 of 8 cores",
  });
  expect(rows[2]?.memory).toEqual({
    pct: 19,
    used: "3",
    total: "16",
    unit: "GiB",
    label: "No zone Memory 19%, 3 of 16 GiB",
  });
  expect(rows[2]?.pods).toEqual({
    pct: 2,
    used: "2",
    total: "110",
    unit: "pods",
    label: "No zone Pods 2%, 2 of 110 pods",
  });

  // The zones' sums are Capacity's.
  const capacity = capacityOf({
    snapshot: ZONED,
    error: null,
    nodesForbidden: false,
    usage: ZONED_USAGE,
  });
  const item = (key: string) => capacity?.items.find((i) => i.key === key);
  const sum = (pick: (r: ZoneRow) => DonutValue, part: "used" | "total") =>
    rows.reduce((total, r) => total + Number(pick(r)[part]), 0);
  const sums = (pick: (r: ZoneRow) => DonutValue) => [
    String(sum(pick, "used")),
    String(sum(pick, "total")),
  ];
  expect(sums((r) => r.cpu)).toEqual(["7", "20"]);
  expect(sums((r) => r.cpu)).toEqual([item("cpu")?.used, item("cpu")?.total]);
  expect(sums((r) => r.memory)).toEqual(["15", "80"]);
  expect(sums((r) => r.memory)).toEqual([
    item("memory")?.used,
    item("memory")?.total,
  ]);
  expect(sums((r) => r.pods)).toEqual(["3", "550"]);
  expect(sums((r) => r.pods)).toEqual([
    item("pods")?.used,
    item("pods")?.total,
  ]);
});

test("without the metrics API a zone reads its nodes' requests, and its donut names say so", () => {
  const rows = zoneRows(ZONED, NOT_SERVED);
  expect(rows[0]?.cpu.label).toBe("zone-2 CPU requests 0%, 0 of 8 cores");
  expect(rows[0]?.memory.label).toBe("zone-2 Memory requests 0%, 0 of 32 GiB");
  expect(rows[2]?.cpu.label).toBe("No zone CPU requests 25%, 1 of 4 cores");
  // Pods are counted, not measured.
  expect(rows[2]?.pods.label).toBe("No zone Pods 2%, 2 of 110 pods");
});

test("hidden pods leave a zone's Pods donut without data", () => {
  const rows = zoneRows(tsnapshot(ZONED.regions, true), ZONED_USAGE);
  expect(rows[0]?.pods).toEqual({
    pct: null,
    used: null,
    total: null,
    unit: "pods",
    label: "zone-2 Pods: no data",
  });
});

test("a zone under 1 GiB of memory reads MiB", () => {
  const [row] = zoneRows(
    tsnapshot([
      tregion(null, [
        tzone("tiny", [
          tnode("t", {
            allocatable: { cpuMillis: 1000, memoryBytes: 512 * MIB, pods: 10 },
          }),
        ]),
      ]),
    ]),
    usage([{ name: "t", cores: 0.5, bytes: 128 * MIB }]),
  );
  expect(row?.memory).toEqual({
    pct: 25,
    used: "128",
    total: "512",
    unit: "MiB",
    label: "tiny Memory 25%, 128 of 512 MiB",
  });
});

test("a donut's caption is its used and total with the unit, but no unit for pods, and No data when unknown", () => {
  const cores = (millis: number) => String(millis / 1000);
  expect(donutCaption(donutValue("x CPU", 3000, 8000, cores, "cores"))).toBe(
    "3 / 8 cores",
  );
  expect(donutCaption(donutValue("x Pods", 2, 220, String, "pods"))).toBe(
    "2 / 220",
  );
  expect(donutCaption(donutValue("x", 4, 6, String, ""))).toBe("4 / 6");
  const unknown = donutValue("x Memory", null, 16, String, "GiB");
  expect(unknown).toEqual({
    pct: null,
    used: null,
    total: null,
    unit: "GiB",
    label: "x Memory: no data",
  });
  expect(donutCaption(unknown)).toBe("No data");
  // A total of zero has no share.
  expect(donutValue("x Pods", 0, 0, String, "pods").pct).toBeNull();
});

function node(name: string, nodeInfo: Record<string, string>): KubeObject {
  return { metadata: { name }, status: { nodeInfo } };
}

test("versions list each value with its nodes, most first, and set each kubelet against the API server", () => {
  const ubuntu = "Ubuntu 24.04.1 LTS";
  const bottlerocket = "Bottlerocket OS 1.20.0";
  const nodes = [
    node("n1", {
      kubeletVersion: "v1.32.4",
      osImage: bottlerocket,
      architecture: "amd64",
    }),
    node("n2", {
      kubeletVersion: "v1.33.1",
      osImage: ubuntu,
      architecture: "amd64",
    }),
    node("n3", {
      kubeletVersion: "v1.33.1",
      osImage: ubuntu,
      architecture: "arm64",
    }),
    // No kubelet version: it counts under a dash.
    node("n4", { osImage: ubuntu, architecture: "amd64" }),
    node("n5", {
      kubeletVersion: "v1.32.4",
      osImage: bottlerocket,
      architecture: "amd64",
    }),
    node("n6", {
      kubeletVersion: "v1.33.1",
      osImage: ubuntu,
      architecture: "amd64",
    }),
  ];
  expect(versionTables(nodes, "v1.33.1")).toEqual([
    {
      id: "kubelets",
      title: "Kubelet versions",
      head: "Version",
      rows: [
        { value: "v1.33.1", nodes: 3, sub: "Same as the API server" },
        { value: "v1.32.4", nodes: 2, sub: "API server v1.33.1" },
        { value: "—", nodes: 1, sub: "" },
      ],
    },
    {
      id: "os-images",
      title: "OS images",
      head: "OS image",
      rows: [
        { value: ubuntu, nodes: 4, sub: "" },
        { value: bottlerocket, nodes: 2, sub: "" },
      ],
    },
    {
      id: "architectures",
      title: "Architectures",
      head: "Architecture",
      rows: [
        { value: "amd64", nodes: 5, sub: "" },
        { value: "arm64", nodes: 1, sub: "" },
      ],
    },
  ]);
});

test("versions with as many nodes sort naturally, and without the API server's version a kubelet has no sub-line", () => {
  const [kubelets, images] = versionTables(
    [
      node("a", { kubeletVersion: "v1.10.0" }),
      node("b", { kubeletVersion: "v1.9.0" }),
    ],
    "",
  );
  expect(kubelets?.rows).toEqual([
    { value: "v1.9.0", nodes: 1, sub: "" },
    { value: "v1.10.0", nodes: 1, sub: "" },
  ]);
  expect(images?.rows).toEqual([{ value: "—", nodes: 2, sub: "" }]);
  expect(versionTables([], "v1.33.1").map((t) => t.rows)).toEqual([[], [], []]);
});

test("a nodes error reads as one sentence", () => {
  expect(nodesError("watch ended")).toBe(
    "Could not read the nodes: watch ended.",
  );
  expect(nodesError("This cluster does not serve Nodes.")).toBe(
    "Could not read the nodes: This cluster does not serve Nodes.",
  );
});
