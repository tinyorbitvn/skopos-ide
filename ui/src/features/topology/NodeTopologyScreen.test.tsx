import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TopologyPod } from "../../ipc/generated/TopologyPod";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { resetTopologyForTest } from "../../stores/topology";
import { CSS_FILES, cssRules } from "../../test/css";
import { servedResource } from "../../test/graph";
import { flush } from "../../test/ipc";
import { metricsServer, usageItem, usageSnapshot } from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import {
  GIB,
  MIB,
  type TopologyBackend,
  tnode,
  topologyBackend,
  tpod,
  tregion,
  tsnapshot,
  tzone,
} from "../../test/topology";
import { NodeTopologyScreen } from "./NodeTopologyScreen";

const PAGE = "/cluster/c1/node-topology";
const CSS = "/src/features/topology/Topology.module.css";

function demo(workerOnePods: TopologyPod[] = W1_PODS) {
  const w1 = tnode("worker-1", {
    labels: {
      "topology.kubernetes.io/region": "eu-west",
      "topology.kubernetes.io/zone": "eu-west-1a",
      team: "payments",
    },
    roles: ["worker"],
    requests: {
      cpuMillis: 2100,
      memoryBytes: Math.round(11.8 * GIB),
      pods: null,
    },
    taints: [
      { key: "dedicated", value: "db", effect: "NoSchedule" },
      { key: "gpu", value: null, effect: "NoExecute" },
    ],
    pods: workerOnePods,
  });
  const w2 = tnode("worker-2", {
    labels: { team: "search" },
    ready: "NotReady",
    unschedulable: true,
    conditions: ["MemoryPressure"],
    allocatable: { cpuMillis: 4000, memoryBytes: 16 * GIB, pods: null },
    requests: { cpuMillis: 500, memoryBytes: 512 * MIB, pods: null },
    pods: [tpod("shop", "web-3", "Pending", "ContainerCreating")],
  });
  const w10 = tnode("worker-10", {
    allocatable: { cpuMillis: null, memoryBytes: 0, pods: 110 },
  });
  const edge = tnode("edge-1", {
    roles: ["control-plane"],
    pods: [tpod("kube-system", "etcd-edge-1")],
  });
  const lab = tnode("lab-1", {
    pods: [
      tpod("lab", "job-1", "Succeeded", "Completed"),
      tpod("lab", "odd", "Unknown"),
    ],
  });
  return tsnapshot([
    tregion("eu-west", [
      tzone("eu-west-1a", [w1, w2, w10]),
      tzone("eu-west-1b", [edge]),
    ]),
    tregion(null, [tzone(null, [lab])]),
  ]);
}

const W1_PODS = [
  tpod("kube-system", "kube-proxy-a"),
  tpod("shop", "web-1"),
  tpod("shop", "web-2", "Failed", "CrashLoopBackOff"),
];

/** What the drawer reads, answered never, so it stays on its title. */
const DRAWER = {
  resources_subscribe: () => "sub",
  resources_subscribe_object: () => "object-sub",
  resources_unsubscribe: () => null,
  resource_get: () => new Promise(() => {}),
  resource_events: () => new Promise(() => {}),
  ui_state_get: () => null,
  ui_state_set: () => null,
};

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

let t: TopologyBackend;

async function show(
  path = PAGE,
  handlers: Parameters<typeof topologyBackend>[0] = {},
) {
  t = topologyBackend({ ...DRAWER, ...handlers });
  const context = {
    clusterId: "c1",
    resources: [
      servedResource("Pod", "", "pods"),
      servedResource("Node", "", "nodes", false),
    ],
    resourcesLoading: false,
    resourcesError: null,
  };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route
            path="cluster/:id/node-topology"
            element={<NodeTopologyScreen />}
          />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );
  await act(flush);
}

async function showDemo(path = PAGE) {
  await show(path);
  await t.send({ type: "snapshot", snapshot: demo() });
}

const where = () => screen.getByTestId("where").textContent;
const text = (id: string) => screen.getByTestId(id).textContent;
/** The texts of the headings of one level inside an element. */
const headings = (id: string, level: 3 | 4) =>
  within(screen.getByTestId(id))
    .queryAllByRole("heading", { level })
    .map((h) => h.textContent);
/** A donut's accessible name. */
const donut = (id: string) =>
  within(screen.getByTestId(id)).getByRole("img").getAttribute("aria-label");

beforeEach(() => {
  resetTopologyForTest();
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
});
afterEach(() => {
  resetTopologyForTest();
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  vi.restoreAllMocks();
});

test("the cluster box holds region boxes, which hold zone boxes, each labelled with its kind", async () => {
  connectClusters({ id: "c1", name: "prod-eu-west" });
  await showDemo();
  expect(text("topology-count")).toBe("5");
  const cluster = screen.getByTestId("topology-cluster");
  expect(text("topology-cluster-label")).toBe("prod-eu-west · kind v1.33.1");
  expect(cluster.querySelector('[data-icon="cluster"]')).not.toBeNull();
  expect(headings("topology-region-eu-west", 3)).toEqual([
    "eu-west · Region · 4 nodes · 5 pods",
  ]);
  expect(headings("topology-region-eu-west", 4)).toEqual([
    "eu-west-1a · Zone · 3 nodes",
    "eu-west-1b · Zone · 1 node",
  ]);
  expect(
    [
      ...screen
        .getByTestId("topology-zone-eu-west-1a")
        .querySelectorAll("[data-testid^='topology-card-']"),
    ].map((c) => c.getAttribute("data-testid")),
  ).toEqual([
    "topology-card-worker-1",
    "topology-card-worker-2",
    "topology-card-worker-10",
  ]);
  // A region with a single zone still draws its zone box.
  expect(headings("topology-region-none", 3)).toEqual([
    "No region · 1 node · 2 pods",
  ]);
  expect(headings("topology-region-none", 4)).toEqual(["No zone · 1 node"]);
  expect(
    [
      "topology-region-eu-west",
      "topology-zone-eu-west-1a",
      "topology-region-none",
      "topology-zone-none",
    ].map((id) => screen.getByTestId(id).hasAttribute("data-muted")),
  ).toEqual([false, false, true, true]);
  expect(
    screen
      .getByTestId("topology-region-eu-west")
      .querySelector('h3 [data-icon="map"]'),
  ).not.toBeNull();
  expect(
    screen
      .getByTestId("topology-zone-eu-west-1a")
      .querySelector('h4 [data-icon="target"]'),
  ).not.toBeNull();
  for (const id of ["topology-region-eu-west", "topology-zone-eu-west-1a"]) {
    const overlay = screen.getByTestId(id).querySelector(":scope > svg");
    expect([
      overlay?.getAttribute("aria-hidden"),
      overlay?.querySelectorAll("rect").length,
    ]).toEqual(["true", 1]);
  }
});

test("the cluster label is the cluster alone until the catalog has it connected", async () => {
  await showDemo();
  expect(text("topology-cluster-label")).toBe("c1");
});

test("the cluster box is solid, region and zone boxes are dashed, and No region and No zone are muted", () => {
  const rules = cssRules(CSS_FILES[CSS] ?? "");
  const decls = (selector: string) =>
    rules.find((r) => r.selector === selector)?.decls;
  expect(decls(".cluster")).toEqual(
    expect.arrayContaining([["border", "2px solid var(--border-accent)"]]),
  );
  expect(decls(".dash rect")).toEqual(
    expect.arrayContaining([
      ["stroke", "var(--text-secondary)"],
      ["stroke-width", "2"],
      ["stroke-dasharray", "8 6"],
    ]),
  );
  expect(decls('.group[data-kind="zone"] .dash rect')).toEqual(
    expect.arrayContaining([
      ["stroke", "var(--border-accent)"],
      ["stroke-width", "1.5"],
      ["stroke-dasharray", "6 5"],
    ]),
  );
  expect(decls(".group[data-muted] .dash rect")).toEqual([
    ["stroke", "var(--text-tertiary)"],
  ]);
  expect(decls(".group[data-muted] .groupLabel")).toEqual([
    ["color", "var(--text-tertiary)"],
  ]);
});

test("a card shows its tab, name, dot and role chips, then its badges, two donuts and pod count", async () => {
  await showDemo();
  const header = screen.getByTestId("topology-node-worker-1");
  expect(header.getAttribute("title")).toBe("worker-1");
  expect(header.querySelector('[data-icon="server"]')).not.toBeNull();
  expect(within(header).getByRole("img", { name: "Ready" })).toBeTruthy();
  expect(within(header).getByText("worker")).toBeTruthy();
  expect([
    donut("topology-cpu-worker-1"),
    donut("topology-memory-worker-1"),
  ]).toEqual(["CPU 53%, 2.1 of 4 cores", "Memory 74%, 11.8 of 16 GiB"]);
  expect(
    [
      ...screen
        .getByTestId("topology-card-worker-1")
        .querySelectorAll(
          "[data-testid^='topology-cpu-'], [data-testid^='topology-memory-']",
        ),
    ].map((d) => d.getAttribute("data-testid")),
  ).toEqual(["topology-cpu-worker-1", "topology-memory-worker-1"]);
  expect(text("topology-pod-count-worker-1")).toBe("3 / 110 pods");
  const taints = screen.getByTestId("topology-taints-worker-1");
  expect(taints.textContent).toBe("2 taints");
  expect(taints.querySelector('[data-icon="triangle-alert"]')).not.toBeNull();
  fireEvent.focus(taints);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "dedicated=db:NoSchedulegpu:NoExecute",
  );

  const w2 = screen.getByTestId("topology-card-worker-2");
  expect([
    w2.getAttribute("data-ready"),
    w2.hasAttribute("data-cordoned"),
  ]).toEqual(["NotReady", true]);
  expect(
    [...screen.getByTestId("topology-badges-worker-2").children].map(
      (b) => b.textContent,
    ),
  ).toEqual(["NotReady", "MemoryPressure", "Cordoned"]);
  expect(screen.queryByTestId("topology-taints-worker-2")).toBeNull();
  expect(text("topology-pod-count-worker-2")).toBe("1 pod");
  expect(screen.queryByTestId("topology-badges-edge-1")).toBeNull();
  expect(
    screen.getByTestId("topology-card-worker-1").hasAttribute("data-cordoned"),
  ).toBe(false);
});

test("a donut without allocatable or a used amount shows a dash (RF1)", async () => {
  await showDemo();
  expect([
    donut("topology-cpu-worker-10"),
    donut("topology-memory-worker-10"),
  ]).toEqual(["CPU unknown", "Memory unknown"]);
  for (const id of ["topology-cpu-worker-10", "topology-memory-worker-10"]) {
    const el = screen.getByTestId(id);
    expect([
      el.querySelectorAll("circle").length,
      el.querySelector("text")?.textContent,
    ]).toEqual([1, "—"]);
  }
  expect(screen.getByTestId("topology-card-worker-10").textContent).not.toMatch(
    /NaN|Infinity|\d%/,
  );
});

test("the filter matches names and label values, recounts, and replaces the URL", async () => {
  await showDemo();
  fireEvent.change(screen.getByTestId("topology-filter"), {
    target: { value: "PAY" },
  });
  expect(text("topology-count")).toBe("1 of 5");
  expect(headings("topology-region-eu-west", 3)).toEqual([
    "eu-west · Region · 1 node · 3 pods",
  ]);
  expect(headings("topology-region-eu-west", 4)).toEqual([
    "eu-west-1a · Zone · 1 node",
  ]);
  expect(screen.queryByTestId("topology-region-none")).toBeNull();
  expect(where()).toBe(`${PAGE}?q=PAY`);
  fireEvent.change(screen.getByTestId("topology-filter"), {
    target: { value: "worker" },
  });
  expect(text("topology-count")).toBe("3 of 5");
});

test("a filter that matches nothing offers to clear it", async () => {
  await showDemo();
  fireEvent.change(screen.getByTestId("topology-filter"), {
    target: { value: "zzz" },
  });
  expect(
    screen.getByRole("heading", { name: "No node matches the filter" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByTestId("topology-clear-filter"));
  expect(screen.getByTestId("topology-card-lab-1")).toBeTruthy();
  expect(where()).toBe(PAGE);
});

test("the highlight menu lists the whole snapshot's namespaces and keeps the choice in the URL", async () => {
  await showDemo(`${PAGE}?q=worker-1`);
  const trigger = screen.getByTestId("topology-highlight");
  expect([trigger.textContent, trigger.getAttribute("title")]).toEqual([
    "Highlight namespace",
    "Highlight namespace",
  ]);
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
    "All namespaces",
    "kube-system",
    "lab",
    "shop",
  ]);
  fireEvent.click(screen.getByTestId("topology-ns-shop"));
  expect(screen.getByTestId("topology-highlight").textContent).toBe("shop");
  expect(where()).toBe(`${PAGE}?q=worker-1&ns=shop`);
  // worker-1 and worker-10 hold "worker-1".
  expect(text("topology-count")).toBe("2 of 5");
  fireEvent.keyDown(screen.getByTestId("topology-highlight"), {
    key: "Enter",
  });
  fireEvent.click(screen.getByTestId("topology-ns-all"));
  expect(screen.getByTestId("topology-highlight").textContent).toBe(
    "Highlight namespace",
  );
  expect(where()).toBe(`${PAGE}?q=worker-1`);
});

test("the legend lists the five states and the note names the requests without metrics", async () => {
  await showDemo();
  expect(
    within(screen.getByRole("list", { name: "Pod states" }))
      .getAllByRole("listitem")
      .map((i) => i.textContent),
  ).toEqual(["Running", "Pending", "Failed", "Succeeded", "Unknown"]);
  expect(text("topology-source")).toBe(
    "CPU and memory: requests, metrics unavailable",
  );
});

test("with node usage from metrics-server the donuts show it; a node it lacks falls back to its requests (RF3)", async () => {
  connectClusters({ id: "c1", name: "kind" });
  await show(PAGE, {
    metrics_provider: () => metricsServer(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({
          name: "worker-1",
          namespace: null,
          cpuCores: 1,
          memoryBytes: 4 * GIB,
        }),
      ]),
  });
  await t.send({ type: "snapshot", snapshot: demo() });
  await act(flush);
  await act(flush);
  expect(text("topology-source")).toBe(
    "CPU and memory: usage from metrics-server",
  );
  expect([
    donut("topology-cpu-worker-1"),
    donut("topology-memory-worker-1"),
    donut("topology-cpu-worker-2"),
    donut("topology-memory-worker-2"),
    donut("topology-cpu-worker-10"),
  ]).toEqual([
    "CPU 25%, 1 of 4 cores",
    "Memory 25%, 4 of 16 GiB",
    "CPU 13%, 0.5 of 4 cores",
    "Memory 3%, 0.5 of 16 GiB",
    "CPU unknown",
  ]);
});

test("a card header opens the node's drawer, and Escape closes it", async () => {
  await showDemo();
  fireEvent.click(screen.getByTestId("topology-node-worker-1"));
  expect(where()).toBe(`${PAGE}?open=nodes&object=%2Fworker-1`);
  await act(flush);
  expect(text("detail-title")).toBe("worker-1");
  expect(text("detail-kind")).toBe("Node");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(where()).toBe(PAGE);
});

test("until the first snapshot it shows a spinner and six skeleton cards", async () => {
  await show();
  expect(screen.getByRole("status", { name: "Loading nodes…" })).toBeTruthy();
  expect(screen.getAllByTestId("topology-skeleton")).toHaveLength(6);
  expect(screen.queryByTestId("topology-count")).toBeNull();
});

test("a cluster without nodes says so", async () => {
  await show();
  await t.send({ type: "snapshot", snapshot: tsnapshot([]) });
  expect(
    screen.getByRole("heading", { name: "This cluster has no nodes" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("topology-loading")).toBeNull();
});

test("a failure keeps the snapshot under a banner whose Retry subscribes again", async () => {
  await showDemo();
  await t.send({ type: "failure", message: "watch ended" });
  const banner = screen.getByRole("alert");
  expect(banner.getAttribute("data-testid")).toBe("topology-error");
  expect(within(banner).getByText("watch ended")).toBeTruthy();
  expect(screen.getByTestId("topology-card-worker-1")).toBeTruthy();
  fireEvent.click(screen.getByTestId("topology-retry"));
  await act(flush);
  expect(t.backend.callsTo("node_topology_subscribe")).toHaveLength(2);
  expect(screen.queryByTestId("topology-error")).toBeNull();
});

test("a failure before any snapshot shows only the banner", async () => {
  await show();
  await t.send({
    type: "failure",
    message: "Listing nodes is not allowed: nodes is forbidden",
  });
  expect(
    within(screen.getByRole("alert")).getByText(
      "Listing nodes is not allowed: nodes is forbidden",
    ),
  ).toBeTruthy();
  expect(screen.queryByTestId("topology-loading")).toBeNull();
  expect(screen.queryByTestId("topology-cluster")).toBeNull();
});

test("hidden pods: a notice, labels without pods, no pod counts, and donuts without requests", async () => {
  await show();
  await t.send({
    type: "snapshot",
    snapshot: tsnapshot(
      [
        tregion("eu-west", [
          tzone("eu-west-1a", [
            tnode("worker-1", {
              requests: { cpuMillis: null, memoryBytes: null, pods: null },
            }),
          ]),
        ]),
      ],
      true,
    ),
  });
  expect(text("topology-pods-hidden")).toBe(
    "Pods are hidden: listing pods is not allowed",
  );
  expect(headings("topology-region-eu-west", 3)).toEqual([
    "eu-west · Region · 1 node",
  ]);
  expect(screen.queryByTestId("topology-pod-count-worker-1")).toBeNull();
  expect(donut("topology-cpu-worker-1")).toBe("CPU unknown");
});

test("the filter and the highlight come back from the URL (RF5)", async () => {
  await showDemo(`${PAGE}?q=worker&ns=gone`);
  expect(
    (screen.getByTestId("topology-filter") as HTMLInputElement).value,
  ).toBe("worker");
  expect(text("topology-count")).toBe("3 of 5");
  expect(text("topology-highlight")).toBe("gone");
});

test("a card is 240 px, and off screen it costs little: content-visibility auto with an intrinsic size (RF4)", () => {
  const card = cssRules(CSS_FILES[CSS] ?? "").find(
    (r) => r.selector === ".card",
  );
  expect(card?.decls).toEqual(
    expect.arrayContaining([
      ["content-visibility", "auto"],
      ["contain-intrinsic-size", "auto 240px auto 220px"],
      ["width", "240px"],
    ]),
  );
});
