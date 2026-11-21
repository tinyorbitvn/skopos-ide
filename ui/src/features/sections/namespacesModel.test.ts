import { expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import type { ListView } from "../workloads/counts";
import {
  donutCell,
  namespaceTiles,
  perNamespaceRows,
  quotaEmpty,
  quotaRows,
  topNamespacesEmpty,
  unavailableState,
} from "./namespacesModel";
import type { SectionTile } from "./tiles";

const ready = (items: KubeObject[]): ListView => ({ state: "ready", items });
const LOADING: ListView = { state: "loading" };
const forbidden = (label: string): ListView => ({
  state: "unavailable",
  reason: `You may not list ${label}.`,
  cause: "forbidden",
});
const notServed = (label: string): ListView => ({
  state: "unavailable",
  reason: `This cluster does not serve ${label}.`,
  cause: "notServed",
});
const FAILED: ListView = {
  state: "unavailable",
  reason: "connection refused",
  cause: "error",
};

const ns = (name: string, phase = "Active"): KubeObject => ({
  metadata: { name },
  status: { phase },
});
const obj = (
  namespace: string,
  name: string,
  rest: Record<string, unknown> = {},
): KubeObject => ({ metadata: { name, namespace }, ...rest });
const quota = (
  namespace: string,
  name: string,
  hard: Record<string, string>,
  used: Record<string, string>,
): KubeObject => obj(namespace, name, { status: { hard, used } });

function tiles(over: Partial<Parameters<typeof namespaceTiles>[0]> = {}) {
  return namespaceTiles({
    clusterId: "c1",
    namespaces: ready([]),
    quotas: ready([]),
    limits: ready([]),
    ...over,
  });
}

function tile(all: SectionTile[], id: string): SectionTile {
  const found = all.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no tile ${id}`);
  return found;
}

/** A tile with its icon named, so tiles compare as plain data. */
const shown = ({ icon, ...rest }: SectionTile) => ({
  ...rest,
  icon: icon.iconName,
});

test("the Summary has four tiles in the spec's order", () => {
  expect(tiles().map((t) => t.id)).toEqual([
    "namespaces",
    "terminating",
    "quota",
    "limits",
  ]);
});

test("the Summary counts every Namespace and names the Terminating ones", () => {
  const all = tiles({
    namespaces: ready([
      ns("default"),
      ns("payments"),
      ns("old-10", "Terminating"),
      ns("old-2", "Terminating"),
      ns("old-3", "Terminating"),
    ]),
  });
  expect(shown(tile(all, "namespaces"))).toEqual({
    id: "namespaces",
    icon: "namespace",
    label: "Namespaces",
    number: "5",
    sub: "2 Active · 3 Terminating",
    tone: "ok",
    to: "/cluster/c1/r/core/namespaces",
  });
  expect(shown(tile(all, "terminating"))).toEqual({
    id: "terminating",
    icon: "trash-2",
    label: "Terminating",
    number: "3",
    sub: "old-2, old-3 and 1 more",
    tone: "warn",
    to: "/cluster/c1/r/core/namespaces",
  });
});

test("without a Terminating namespace the sub-lines read Active alone and None", () => {
  const all = tiles({ namespaces: ready([ns("default")]) });
  expect(tile(all, "namespaces")).toMatchObject({
    number: "1",
    sub: "1 Active",
    tone: "ok",
  });
  expect(tile(all, "terminating")).toMatchObject({
    number: "0",
    sub: "None",
    tone: "ok",
  });
});

test("a namespace with a quota or a limit counts once, however many it holds", () => {
  const all = tiles({
    quotas: ready([
      quota("payments", "compute", {}, {}),
      quota("payments", "objects", {}, {}),
      quota("default", "small", {}, {}),
    ]),
    limits: ready([obj("payments", "defaults")]),
  });
  expect(shown(tile(all, "quota"))).toEqual({
    id: "quota",
    icon: "sliders-horizontal",
    label: "With a ResourceQuota",
    number: "2",
    sub: "3 ResourceQuotas",
    tone: "neutral",
    to: "/cluster/c1/r/core/resourcequotas",
  });
  expect(shown(tile(all, "limits"))).toEqual({
    id: "limits",
    icon: "scan",
    label: "With a LimitRange",
    number: "1",
    sub: "1 LimitRange",
    tone: "neutral",
    to: "/cluster/c1/r/core/limitranges",
  });
});

test("a list loading, forbidden, not served or failing gives its tiles the waiting sub-lines", () => {
  const all = tiles({
    namespaces: LOADING,
    quotas: forbidden("ResourceQuotas"),
    limits: notServed("LimitRanges"),
  });
  expect(tile(all, "namespaces")).toMatchObject({
    number: "—",
    sub: "Loading",
    tone: "neutral",
    to: "/cluster/c1/r/core/namespaces",
  });
  expect(tile(all, "terminating")).toMatchObject({
    number: "—",
    sub: "Loading",
  });
  expect(tile(all, "quota")).toMatchObject({
    number: "—",
    sub: "You may not list ResourceQuotas",
    tone: "neutral",
    to: null,
  });
  expect(tile(all, "limits")).toMatchObject({
    number: "—",
    sub: "This cluster does not serve LimitRanges",
    to: null,
  });
  expect(tile(tiles({ quotas: FAILED }), "quota")).toMatchObject({
    number: "—",
    sub: "Could not list ResourceQuotas",
    to: "/cluster/c1/r/core/resourcequotas",
  });
});

test("a chosen namespace that is gone adds no row", () => {
  const namespaces = [ns("payments"), ns("checkout")];
  const rows = perNamespaceRows(
    namespaces,
    ["payments", "gone"],
    [{ plural: "pods", view: ready([obj("payments", "api-0")]) }],
  );
  expect(rows.map((r) => [r.object.metadata.name, r.counts])).toEqual([
    ["payments", [1]],
  ]);
  // The lists are already filtered to the selection, so the gone namespace holds nothing.
  const all = tiles({
    namespaces: ready(namespaces),
    quotas: ready([]),
    limits: ready([]),
  });
  expect(tile(all, "quota")).toMatchObject({
    number: "0",
    sub: "0 ResourceQuotas",
  });
  expect(tile(all, "limits")).toMatchObject({
    number: "0",
    sub: "0 LimitRanges",
  });
});

test("Pods and workloads per namespace: most Pods first, then by name, and null where a kind is not listed", () => {
  const rows = perNamespaceRows(
    [ns("b-10"), ns("b-2"), ns("busy")],
    [],
    [
      {
        plural: "pods",
        view: ready([obj("busy", "a"), obj("busy", "b"), obj("b-10", "c")]),
      },
      { plural: "deployments", view: ready([obj("busy", "web")]) },
      { plural: "jobs", view: forbidden("Jobs") },
      { plural: "cronjobs", view: LOADING },
    ],
  );
  expect(rows.map((r) => [r.object.metadata.name, r.counts])).toEqual([
    ["busy", [2, 1, null, null]],
    ["b-10", [1, 0, null, null]],
    ["b-2", [0, 0, null, null]],
  ]);
  const tied = perNamespaceRows(
    [ns("b-10"), ns("b-2")],
    [],
    [{ plural: "pods", view: ready([]) }],
  );
  expect(tied.map((r) => r.object.metadata.name)).toEqual(["b-2", "b-10"]);
});

test("cpu and memory count as requests, in any quantity form", () => {
  const long = quota(
    "payments",
    "compute",
    { "requests.cpu": "4", "requests.memory": "4Gi", pods: "10" },
    { "requests.cpu": "1500m", "requests.memory": "2Gi", pods: "3" },
  );
  const short = quota(
    "payments",
    "compute",
    { cpu: "4000m", memory: "4096Mi", pods: "10" },
    { cpu: "1.5", memory: "2147483648", pods: "3" },
  );
  expect(quotaRows([long])[0].cells).toEqual([
    {
      pct: 38,
      used: "1.5",
      total: "4",
      unit: "cores",
      label: "payments/compute requests.cpu 38%, 1.5 of 4 cores",
    },
    {
      pct: 50,
      used: "2",
      total: "4",
      unit: "GiB",
      label: "payments/compute requests.memory 50%, 2 of 4 GiB",
    },
    {
      pct: 30,
      used: "3",
      total: "10",
      unit: "pods",
      label: "payments/compute pods 30%, 3 of 10 pods",
    },
  ]);
  expect(quotaRows([short])[0].cells).toEqual(quotaRows([long])[0].cells);
  // Decimal suffixes read in GiB as well: 2G of 4G.
  const decimal = quota(
    "payments",
    "compute",
    { memory: "4G" },
    { memory: "2G" },
  );
  expect(quotaRows([decimal])[0].cells).toEqual([
    null,
    {
      pct: 50,
      used: "1.9",
      total: "3.7",
      unit: "GiB",
      label: "payments/compute requests.memory 50%, 1.9 of 3.7 GiB",
    },
    null,
  ]);
});

test("Quota usage goes by namespace, then by name naturally, and a resource the quota does not set is null", () => {
  const rows = quotaRows([
    quota("payments", "q-10", { pods: "10" }, { pods: "1" }),
    quota("payments", "q-2", { pods: "10" }, { pods: "1" }),
    quota(
      "checkout",
      "main",
      { "requests.cpu": "2" },
      { "requests.cpu": "500m" },
    ),
  ]);
  expect(
    rows.map((r) => `${r.object.metadata.namespace}/${r.object.metadata.name}`),
  ).toEqual(["checkout/main", "payments/q-2", "payments/q-10"]);
  expect(rows[0].cells).toEqual([
    {
      pct: 25,
      used: "0.5",
      total: "2",
      unit: "cores",
      label: "checkout/main requests.cpu 25%, 0.5 of 2 cores",
    },
    null,
    null,
  ]);
});

test("a quota the controller has not counted yet reads no data, and status.hard wins over spec.hard", () => {
  const fresh = obj("payments", "compute", {
    spec: { hard: { pods: "10" } },
    status: {},
  });
  expect(quotaRows([fresh])[0].cells[2]).toEqual({
    pct: null,
    used: null,
    total: null,
    unit: "pods",
    label: "payments/compute pods: no data",
  });
  const changed = obj("payments", "compute", {
    spec: { hard: { pods: "20" } },
    status: { hard: { pods: "10" }, used: { pods: "5" } },
  });
  expect(quotaRows([changed])[0].cells[2]).toMatchObject({
    pct: 50,
    used: "5",
    total: "10",
  });
});

test("a donut cell captions used of total, and a resource not set reads a dim dash", () => {
  expect(donutCell(null)).toEqual({ text: "—", tone: "dim" });
  expect(
    donutCell({ pct: 63, used: "2.5", total: "4", unit: "cores", label: "x" }),
  ).toEqual({
    donut: {
      pct: 63,
      used: "2.5",
      total: "4",
      unit: "cores",
      label: "x",
      caption: "2.5 / 4 cores",
    },
  });
  expect(
    donutCell({ pct: null, used: null, total: null, unit: "pods", label: "y" }),
  ).toEqual({
    donut: {
      pct: null,
      used: null,
      total: null,
      unit: "pods",
      label: "y",
      caption: "No data",
    },
  });
});

test("Quota usage's empty state names the chosen namespaces, or says no namespace has a quota", () => {
  expect(quotaEmpty(ready([]), ["payments", "checkout"])).toEqual({
    title: "No ResourceQuotas",
    text: "No ResourceQuota in payments, checkout.",
  });
  expect(quotaEmpty(ready([]), [])).toEqual({
    title: "No ResourceQuotas",
    text: "No namespace of this cluster has a quota.",
  });
  expect(quotaEmpty(forbidden("ResourceQuotas"), [])).toEqual({
    title: "You may not list ResourceQuotas",
    text: "",
  });
});

test("a card that cannot read its list says why", () => {
  const states = [forbidden("Namespaces"), notServed("Namespaces"), FAILED].map(
    (view) =>
      view.state === "unavailable"
        ? unavailableState(view, "Namespaces")
        : null,
  );
  expect(states).toEqual([
    { title: "You may not list Namespaces", text: "" },
    { title: "This cluster does not serve Namespaces", text: "" },
    { title: "Could not list Namespaces", text: "connection refused" },
  ]);
});

test("Top namespaces says why it has no table, or nothing when it has one", () => {
  const none = {
    metricsOff: false,
    reading: false,
    notServed: false,
    nodesForbidden: false,
  };
  expect(topNamespacesEmpty(none)).toBeNull();
  expect(topNamespacesEmpty({ ...none, metricsOff: true })).toEqual({
    title: "Top namespaces need metrics-server",
    text: "No metrics source is set for this cluster (metrics-server or Prometheus), so usage by namespace is unknown.",
  });
  expect(topNamespacesEmpty({ ...none, reading: true })).toEqual({
    title: "Reading usage",
    text: "Checking where this cluster reports usage.",
  });
  expect(topNamespacesEmpty({ ...none, notServed: true })).toEqual({
    title: "Top namespaces need metrics-server",
    text: "This cluster does not serve the metrics API (metrics.k8s.io), so usage by namespace is unknown.",
  });
  expect(topNamespacesEmpty({ ...none, nodesForbidden: true })).toEqual({
    title: "Top namespaces are not shown",
    text: "Your account may not list nodes, so shares of the cluster cannot be summed.",
  });
});
