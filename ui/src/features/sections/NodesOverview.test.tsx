import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { WatchStatus } from "../../ipc/generated/WatchStatus";
import type { KubeObject } from "../../kinds/objects";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { resetTopologyForTest } from "../../stores/topology";
import { CSS_FILES, cssRules } from "../../test/css";
import { servedResource } from "../../test/graph";
import { flush } from "../../test/ipc";
import {
  metricsServer,
  NO_METRICS_SERVER,
  noProvider,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import {
  GIB,
  tnode,
  topologyBackend,
  tpod,
  tregion,
  tsnapshot,
  tzone,
} from "../../test/topology";
import type { ClusterOutletContext } from "../cluster/ClusterLayout";
import { NodesOverview, resetNodesOverviewForTest } from "./NodesOverview";

const NODES_INFO = servedResource("Node", "", "nodes", false);
const RESOURCES: ApiResourceInfo[] = [NODES_INFO];

/**
 * Four nodes of 4 cores, 16 GiB and 110 pods: worker-1 cordoned with requests and two Pods,
 * worker-2 NotReady under pressure, worker-10 alone in its zone, edge-1 without a zone.
 */
const SNAPSHOT = tsnapshot([
  tregion("eu-west", [
    tzone("eu-west-1a", [
      tnode("worker-1", {
        roles: ["worker"],
        unschedulable: true,
        requests: { cpuMillis: 1000, memoryBytes: 2 * GIB, pods: null },
        pods: [tpod("shop", "api-0"), tpod("shop", "web-0")],
      }),
      tnode("worker-2", {
        roles: ["worker"],
        ready: "NotReady",
        conditions: ["MemoryPressure", "DiskPressure"],
      }),
    ]),
    tzone("eu-west-1b", [
      tnode("worker-10", { roles: ["worker"], pods: [tpod("shop", "db-0")] }),
    ]),
  ]),
  tregion(null, [tzone(null, [tnode("edge-1", { roles: ["control-plane"] })])]),
]);
const NODE_USAGE = usageSnapshot([
  usageItem({
    namespace: null,
    name: "worker-1",
    cpuCores: 2,
    memoryBytes: 8 * GIB,
  }),
  usageItem({
    namespace: null,
    name: "worker-2",
    cpuCores: 1,
    memoryBytes: 12 * GIB,
  }),
  usageItem({
    namespace: null,
    name: "worker-10",
    cpuCores: 3,
    memoryBytes: 4 * GIB,
  }),
  usageItem({
    namespace: null,
    name: "edge-1",
    cpuCores: 0.5,
    memoryBytes: 2 * GIB,
  }),
]);

/** A Node row as the Nodes list trims it (R7). */
function nodeRow(
  name: string,
  kubeletVersion: string,
  osImage: string,
  architecture: string,
): KubeObject {
  return {
    metadata: { name, uid: `node-${name}`, resourceVersion: "1" },
    status: { nodeInfo: { kubeletVersion, osImage, architecture } },
  };
}
const NODE_ROWS = [
  nodeRow("worker-1", "v1.33.1", "Ubuntu 24.04.1 LTS", "amd64"),
  nodeRow("worker-2", "v1.33.1", "Ubuntu 24.04.1 LTS", "arm64"),
  nodeRow("worker-10", "v1.32.4", "Bottlerocket OS 1.20.0", "amd64"),
  nodeRow("edge-1", "v1.33.1", "Ubuntu 24.04.1 LTS", "amd64"),
];

function fake(over: Record<string, (a: never) => unknown> = {}) {
  const subs = new Map<string, (e: WatchEvent) => void>();
  const topology = topologyBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    metrics_provider: () => metricsServer(),
    metrics_usage: () => NODE_USAGE,
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    // What the drawer reads, answered never, so it stays on its title.
    resources_subscribe_object: () => "object-sub",
    resource_get: () => new Promise(() => {}),
    resource_events: () => new Promise(() => {}),
    ...over,
  });
  const nodesEvent = async (event: WatchEvent) => {
    await act(async () => {
      subs.get("nodes")?.(event);
      await flush();
    });
  };
  /** The Nodes list's first rows. */
  const nodes = (items: KubeObject[]) =>
    nodesEvent({ type: "snapshot", items } as WatchEvent);
  const nodesStatus = (status: WatchStatus) =>
    nodesEvent({ type: "status", status, message: null });
  return { ...topology, nodes, nodesStatus };
}

type Fake = ReturnType<typeof fake>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

const PAGE = "/cluster/c1/nodes-overview";

async function show(
  f: Fake = fake(),
  resources: ApiResourceInfo[] = RESOURCES,
  over: Partial<ClusterOutletContext> = {},
) {
  const context: ClusterOutletContext = {
    clusterId: "c1",
    resources,
    resourcesLoading: false,
    resourcesError: null,
    ...over,
  };
  const view = render(
    <MemoryRouter initialEntries={[PAGE]}>
      <Routes>
        <Route path="/cluster/:id" element={<Outlet context={context} />}>
          <Route
            path="nodes-overview"
            element={
              <>
                <NodesOverview />
                <Where />
              </>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  // The saved namespace choice, then the metrics provider and the first usage poll.
  await act(flush);
  await act(flush);
  return { f, unmount: view.unmount };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const href = (id: string) => screen.getByTestId(id).getAttribute("href");
const card = (name: string) =>
  screen.getByTestId(`nodes-overview-card-${name}`);
/** A table's row keys, in order. */
const rowKeys = (table: string) =>
  screen
    .getAllByTestId(new RegExp(`^${table}-row-`))
    .map((r) => r.getAttribute("data-testid")?.slice(`${table}-row-`.length));
/** A row's cells' texts after its name: the name may be a row header or a cell. */
const cells = (id: string) => {
  const row = within(screen.getByTestId(id));
  return [...row.queryAllByRole("rowheader"), ...row.queryAllByRole("cell")]
    .map((c) => c.textContent)
    .slice(1);
};
const heads = (table: string) =>
  within(screen.getByTestId(table))
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
/** The accessible names of a row's donuts. */
const donuts = (id: string) =>
  within(screen.getByTestId(id))
    .getAllByRole("img")
    .map((d) => d.getAttribute("aria-label"));
const tile = (id: string) => [
  text(`overview-tile-${id}-number`),
  text(`overview-tile-${id}-sub`),
  screen.getByTestId(`overview-tile-${id}`).getAttribute("data-tone"),
];
const STATE_IDS = ["ready", "not-ready", "cordoned", "pressure"];

beforeEach(() => {
  resetTopologyForTest();
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  resetNodesOverviewForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("the page is titled Nodes overview, with Capacity beside Nodes by state, Busiest nodes beside By zone, then Versions", async () => {
  const { f } = await show(
    fake({
      ui_state_get: (a: { key: string }) =>
        a.key === "namespaces:c1" ? ["shop"] : null,
    }),
  );
  expect(text("nodes-overview-title")).toBe("Nodes overview");
  const grid = card("capacity").parentElement?.parentElement as HTMLElement;
  expect(
    [...grid.children].map((c) => [
      c.getAttribute("data-span"),
      c.firstElementChild?.getAttribute("data-testid"),
    ]),
  ).toEqual([
    ["5", "nodes-overview-card-capacity"],
    ["7", "nodes-overview-card-state"],
    ["5", "nodes-overview-card-busiest"],
    ["7", "nodes-overview-card-zones"],
    ["12", "nodes-overview-card-versions"],
  ]);
  expect(
    ["capacity", "state", "busiest", "zones", "versions"].map(
      (name) => within(card(name)).getAllByRole("heading")[0]?.textContent,
    ),
  ).toEqual([
    "Capacity",
    "Nodes by state",
    "Busiest nodes",
    "By zone",
    "Versions",
  ]);
  // Nodes are cluster-scoped: the lists' namespaces neither show nor narrow the list.
  expect(screen.queryByTestId("nodes-overview-namespaces")).toBeNull();
  expect(
    f.backend
      .callsTo("resources_subscribe")
      .map((a) => [(a.resource as ResourceRef).plural, a.namespaces]),
  ).toEqual([["nodes", []]]);
});

test("until the topology and the Nodes list arrive, each card shows it is loading", async () => {
  await show();
  expect(within(card("capacity")).getByText("Loading capacity")).toBeTruthy();
  for (const id of STATE_IDS) {
    expect(tile(id)).toEqual(["—", "Loading", "neutral"]);
    expect(href(`overview-tile-${id}`)).toBe("/cluster/c1/r/core/nodes");
  }
  expect(within(card("busiest")).getByText("Loading nodes")).toBeTruthy();
  expect(screen.queryByTestId("nodes-busiest-by")).toBeNull();
  expect(screen.getByTestId("nodes-zones-loading")).toBeTruthy();
  for (const id of [
    "nodes-kubelets",
    "nodes-os-images",
    "nodes-architectures",
  ]) {
    expect(screen.getByTestId(`${id}-loading`)).toBeTruthy();
  }
});

test("Nodes by state counts the topology's nodes, and each tile opens the Nodes list", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  expect(
    within(card("state"))
      .getAllByRole("link")
      .map((a) => a.getAttribute("data-testid")),
  ).toEqual(STATE_IDS.map((id) => `overview-tile-${id}`));
  // worker-1 is cordoned and Ready: it counts in both tiles.
  expect(tile("ready")).toEqual(["3", "Of 4 nodes", "ok"]);
  expect(tile("not-ready")).toEqual(["1", "worker-2", "danger"]);
  expect(tile("cordoned")).toEqual(["1", "worker-1", "warn"]);
  expect(tile("pressure")).toEqual([
    "1",
    "worker-2: MemoryPressure, DiskPressure",
    "warn",
  ]);
  for (const id of STATE_IDS) {
    expect(href(`overview-tile-${id}`)).toBe("/cluster/c1/r/core/nodes");
  }
});

test("Capacity sums the topology with metrics-server, as on the cluster Overview", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  expect(text("overview-capacity-cpu-values")).toBe("6.5 / 16 cores");
  expect(text("overview-capacity-cpu-note")).toBe("Requests 6%");
  expect(text("overview-capacity-memory-values")).toBe("26 / 64 GiB");
  expect(text("overview-capacity-pods-values")).toBe("3 / 440 pods");
  expect(text("overview-capacity-caption")).toBe(
    "CPU and memory: usage from metrics-server",
  );
});

test("Busiest nodes rank the nodes by their own CPU usage, and the switch ranks them by memory", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  const busiest = card("busiest");
  expect(screen.getByTestId("nodes-busiest-by")).toBeTruthy();
  expect(within(busiest).getByText("By CPU usage")).toBeTruthy();
  expect(heads("nodes-busiest")).toEqual(["Node", "CPU", "Usage"]);
  expect(rowKeys("nodes-busiest")).toEqual([
    "worker-10",
    "worker-1",
    "worker-2",
    "edge-1",
  ]);
  const top = screen.getByTestId("nodes-busiest-row-worker-10");
  expect(top.textContent).toContain("worker · eu-west-1b");
  expect(top.textContent).toContain("3 cores");
  expect(donuts("nodes-busiest-row-worker-10")).toEqual([
    "worker-10 CPU 75%, 3 of 4 cores",
  ]);
  expect(text("nodes-busiest-row-edge-1")).toContain("control-plane");
  expect(donuts("nodes-busiest-row-edge-1")).toEqual([
    "edge-1 CPU 13%, 0.5 of 4 cores",
  ]);

  fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  expect(within(busiest).getByText("By memory usage")).toBeTruthy();
  expect(heads("nodes-busiest")).toEqual(["Node", "Memory", "Usage"]);
  expect(rowKeys("nodes-busiest")).toEqual([
    "worker-2",
    "worker-1",
    "worker-10",
    "edge-1",
  ]);
  expect(text("nodes-busiest-row-worker-2")).toContain("12 GiB");
  expect(donuts("nodes-busiest-row-worker-2")).toEqual([
    "worker-2 Memory 75%, 12 of 16 GiB",
  ]);
});

test("the Busiest nodes choice is kept when the page opens again", async () => {
  const { f, unmount } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  unmount();
  // The topology watch lingers and keeps its snapshot; a new watch gets it here.
  const again = await show();
  await again.f.send({ type: "snapshot", snapshot: SNAPSHOT });
  expect(
    (screen.getByRole("radio", { name: "Memory" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(rowKeys("nodes-busiest")[0]).toBe("worker-2");
});

test("a busiest row opens its Node's drawer over the page, and Escape closes it", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  fireEvent.click(screen.getByTestId("nodes-busiest-open-worker-10"));
  expect(text("where")).toBe(`${PAGE}?open=nodes&object=%2Fworker-10`);
  await act(flush);
  expect(text("detail-title")).toBe("worker-10");
  expect(text("detail-kind")).toBe("Node");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe(PAGE);
});

test("without metrics.k8s.io, Busiest nodes needs metrics-server and By zone and Capacity read the requests", async () => {
  const { f } = await show(
    fake({
      metrics_usage: () => {
        throw NO_METRICS_SERVER;
      },
    }),
  );
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  await act(flush);
  const busiest = card("busiest");
  expect(
    within(busiest).getByRole("heading", {
      name: "Busiest nodes need metrics-server",
    }),
  ).toBeTruthy();
  expect(busiest.textContent).toContain(
    "This cluster does not serve the metrics API (metrics.k8s.io), so usage by node is unknown.",
  );
  expect(screen.queryByTestId("nodes-busiest-by")).toBeNull();
  expect(screen.queryByTestId("nodes-busiest")).toBeNull();

  expect(heads("nodes-zones")).toEqual([
    "Zone",
    "Nodes",
    "CPU requests",
    "Memory requests",
    "Pods",
  ]);
  expect(donuts("nodes-zones-row-eu-west/eu-west-1a")).toEqual([
    "eu-west-1a CPU requests 13%, 1 of 8 cores",
    "eu-west-1a Memory requests 6%, 2 of 32 GiB",
    "eu-west-1a Pods 1%, 2 of 220 pods",
  ]);
  expect(text("nodes-zones-caption")).toBe(
    "CPU and memory: requests, metrics unavailable",
  );
  expect(text("overview-capacity-cpu-values")).toBe("1 / 16 cores");
});

test("with no metrics provider, Busiest nodes says no metrics source is set and hides the switch", async () => {
  const { f } = await show(fake({ metrics_provider: () => noProvider() }));
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  await act(flush);
  const busiest = card("busiest");
  expect(
    within(busiest).getByRole("heading", {
      name: "Busiest nodes need metrics-server",
    }),
  ).toBeTruthy();
  expect(busiest.textContent).toContain(
    "No metrics source is set for this cluster (metrics-server or Prometheus), so usage by node is unknown.",
  );
  expect(screen.queryByTestId("nodes-busiest-by")).toBeNull();
  expect(text("nodes-zones-caption")).toBe(
    "CPU and memory: requests, metrics unavailable",
  );
});

test("while the metrics provider is read, Busiest nodes says so", async () => {
  const { f } = await show(
    fake({ metrics_provider: () => new Promise(() => {}) }),
  );
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  const busiest = card("busiest");
  expect(
    within(busiest).getByRole("heading", { name: "Reading usage" }),
  ).toBeTruthy();
  expect(busiest.textContent).toContain(
    "Checking where this cluster reports usage.",
  );
  expect(screen.queryByTestId("nodes-busiest-by")).toBeNull();
});

test("By zone lists the zones in natural order with No zone last, each opening the Node topology", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  expect(heads("nodes-zones")).toEqual([
    "Zone",
    "Nodes",
    "CPU",
    "Memory",
    "Pods",
  ]);
  expect(rowKeys("nodes-zones")).toEqual([
    "eu-west/eu-west-1a",
    "eu-west/eu-west-1b",
    "/No zone",
  ]);
  const zone = screen.getByTestId("nodes-zones-row-eu-west/eu-west-1a");
  expect(within(zone).getByRole("link").getAttribute("href")).toBe(
    "/cluster/c1/node-topology",
  );
  expect(within(zone).getByRole("link").textContent).toContain("eu-west-1a");
  expect(cells("nodes-zones-row-eu-west/eu-west-1a")[0]).toBe("2");
  expect(donuts("nodes-zones-row-eu-west/eu-west-1a")).toEqual([
    "eu-west-1a CPU 38%, 3 of 8 cores",
    "eu-west-1a Memory 63%, 20 of 32 GiB",
    "eu-west-1a Pods 1%, 2 of 220 pods",
  ]);
  for (const caption of ["3 / 8 cores", "20 / 32 GiB", "2 / 220"]) {
    expect(zone.textContent).toContain(caption);
  }
  expect(donuts("nodes-zones-row-/No zone")).toEqual([
    "No zone CPU 13%, 0.5 of 4 cores",
    "No zone Memory 13%, 2 of 16 GiB",
    "No zone Pods 0%, 0 of 110 pods",
  ]);
  expect(text("nodes-zones-caption")).toBe(
    "CPU and memory: usage from metrics-server",
  );
});

test("a topology failure leaves Capacity's caption, and the state tiles, Busiest nodes and By zone with the error", async () => {
  const { f } = await show();
  await f.nodes(NODE_ROWS);
  await f.send({ type: "failure", message: "watch ended" });
  expect(text("overview-capacity-caption")).toBe(
    "Capacity could not be read: watch ended.",
  );
  for (const name of ["state", "busiest", "zones"]) {
    expect(card(name).textContent).toContain(
      "Could not read the nodes: watch ended.",
    );
  }
  expect(screen.queryByTestId("overview-tile-ready")).toBeNull();
  expect(screen.queryByTestId("nodes-busiest")).toBeNull();
  expect(screen.queryByTestId("nodes-zones")).toBeNull();
  // Versions read the Nodes list, which still answers.
  expect(rowKeys("nodes-kubelets")).toEqual(["v1.33.1", "v1.32.4"]);
});

test("Versions count the Nodes list's kubelets, OS images and architectures side by side, each kubelet against the API server", async () => {
  const { f } = await show();
  await f.nodes(NODE_ROWS);
  const versions = card("versions");
  const sideBySide = versions.querySelector(".sideBySide");
  for (const id of [
    "nodes-kubelets",
    "nodes-os-images",
    "nodes-architectures",
  ]) {
    expect(sideBySide?.contains(screen.getByTestId(id))).toBe(true);
  }
  for (const title of ["Kubelet versions", "OS images", "Architectures"]) {
    expect(versions.textContent).toContain(title);
  }
  expect(heads("nodes-kubelets")).toEqual(["Version", "Nodes"]);
  expect(heads("nodes-os-images")).toEqual(["OS image", "Nodes"]);
  expect(heads("nodes-architectures")).toEqual(["Architecture", "Nodes"]);

  // The API server is v1.33.1.
  expect(rowKeys("nodes-kubelets")).toEqual(["v1.33.1", "v1.32.4"]);
  expect(text("nodes-kubelets-row-v1.33.1")).toContain(
    "Same as the API server",
  );
  expect(cells("nodes-kubelets-row-v1.33.1")).toEqual(["3 nodes"]);
  expect(text("nodes-kubelets-row-v1.32.4")).toContain("API server v1.33.1");
  expect(cells("nodes-kubelets-row-v1.32.4")).toEqual(["1 node"]);
  expect(rowKeys("nodes-os-images")).toEqual([
    "Ubuntu 24.04.1 LTS",
    "Bottlerocket OS 1.20.0",
  ]);
  expect(rowKeys("nodes-architectures")).toEqual(["amd64", "arm64"]);
  expect(cells("nodes-architectures-row-amd64")).toEqual(["3 nodes"]);

  // Each table keeps 280 px and wraps below that.
  const rule = cssRules(
    CSS_FILES["/src/features/sections/Sections.module.css"] ?? "",
  ).find((r) => r.selector === ".sideBySide");
  expect(Object.fromEntries(rule?.decls ?? [])).toMatchObject({
    display: "grid",
    "grid-template-columns": "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
  });
});

test("when discovery fails, Versions say the nodes could not be read", async () => {
  await show(fake(), [], { resourcesError: "discovery failed" });
  expect(card("versions").textContent).toContain(
    "Could not read the nodes: discovery failed.",
  );
  expect(screen.queryByTestId("nodes-kubelets")).toBeNull();
});

test("a cluster without nodes says so in By zone and Versions", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: tsnapshot([]) });
  await f.nodes([]);
  const zones = text("nodes-zones-empty");
  expect(zones).toContain("This cluster has no nodes");
  expect(zones).toContain("Nodes appear here once the cluster lists them.");
  expect(screen.queryByTestId("nodes-zones-caption")).toBeNull();
  expect(text("nodes-kubelets-empty")).toContain("This cluster has no nodes");
  expect(tile("ready")).toEqual(["0", "Of 0 nodes", "ok"]);
  expect(card("busiest").textContent).toContain("No usage reported yet");
});

test("without the right to list nodes the page shows one empty state and watches nothing", async () => {
  const { f } = await show(fake(), [{ ...NODES_INFO, canList: false }]);
  expect(text("nodes-overview-title")).toBe("Nodes overview");
  const denied = screen.getByTestId("nodes-overview-denied");
  expect(within(denied).getByRole("heading").textContent).toBe(
    "You may not list nodes",
  );
  expect(denied.textContent).toContain(
    "The nodes API is forbidden for your account, so their state, zones and versions are unknown.",
  );
  expect(screen.queryByTestId("nodes-overview-card-capacity")).toBeNull();
  expect(f.backend.callsTo("node_topology_subscribe")).toHaveLength(0);
  expect(f.backend.callsTo("metrics_usage")).toHaveLength(0);
  expect(f.backend.callsTo("resources_subscribe")).toHaveLength(0);
});

test("a Nodes list the API server forbids denies the page too", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  await f.nodesStatus("forbidden");
  expect(
    within(screen.getByTestId("nodes-overview-denied")).getByRole("heading")
      .textContent,
  ).toBe("You may not list nodes");
  expect(screen.queryByTestId("nodes-overview-card-state")).toBeNull();
});
