import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { resetTopologyForTest } from "../../stores/topology";
import { servedResource } from "../../test/graph";
import { flush } from "../../test/ipc";
import {
  metricsServer,
  NO_METRICS_SERVER,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import {
  GIB,
  MIB,
  tnode,
  topologyBackend,
  tpod,
  tregion,
  tsnapshot,
  tzone,
} from "../../test/topology";
import { ClusterHome } from "./ClusterHome";
import type { ClusterOutletContext } from "./ClusterLayout";
import { resetTopConsumersForTest } from "./TopConsumersCard";

const INFO: ClusterInfo = {
  version: "v1.33.1",
  distribution: "kind",
  nodeCount: 2,
  namespaces: ["default", "shop"],
  namespacesRestricted: false,
  isAdmin: true,
};

const RESOURCES: ApiResourceInfo[] = [
  servedResource("Pod", "", "pods"),
  servedResource("Node", "", "nodes", false),
  servedResource("Namespace", "", "namespaces", false),
  servedResource("Deployment", "apps", "deployments"),
  servedResource("DaemonSet", "apps", "daemonsets"),
  servedResource("StatefulSet", "apps", "statefulsets"),
  servedResource("ReplicaSet", "apps", "replicasets"),
  servedResource("Job", "batch", "jobs"),
  servedResource("CronJob", "batch", "cronjobs"),
  servedResource("Event", "", "events"),
];
const WORKLOAD_PLURALS = [
  "deployments",
  "daemonsets",
  "statefulsets",
  "replicasets",
  "jobs",
  "cronjobs",
];

/** Two nodes of 4 cores, 16 GiB and 110 pods; n1 holds two Pods. */
const SNAPSHOT = tsnapshot([
  tregion(null, [
    tzone(null, [
      tnode("n1", {
        requests: { cpuMillis: 2000, memoryBytes: 4 * GIB, pods: null },
        pods: [tpod("shop", "api-0"), tpod("ingest", "kafka-0")],
      }),
      tnode("n2", {
        requests: { cpuMillis: 1000, memoryBytes: 4 * GIB, pods: null },
      }),
    ]),
  ]),
]);
const NODE_USAGE = usageSnapshot([
  usageItem({
    namespace: null,
    name: "n1",
    cpuCores: 1.5,
    memoryBytes: 6 * GIB,
  }),
  usageItem({
    namespace: null,
    name: "n2",
    cpuCores: 0.5,
    memoryBytes: 2 * GIB,
  }),
]);
const POD_USAGE = usageSnapshot([
  usageItem({
    namespace: "shop",
    name: "api-0",
    cpuCores: 0.994,
    memoryBytes: 870 * MIB,
  }),
  usageItem({
    namespace: "ingest",
    name: "kafka-0",
    cpuCores: 1.2,
    memoryBytes: 3.4 * GIB,
  }),
]);

function fake(over: Record<string, (a: never) => unknown> = {}) {
  const subs = new Map<string, (e: WatchEvent) => void>();
  const topology = topologyBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    metrics_provider: () => metricsServer(),
    metrics_usage: (a: { of: string }) =>
      a.of === "nodes" ? NODE_USAGE : POD_USAGE,
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    resources_subscribe_object: () => "object-sub",
    resource_get: () => new Promise(() => {}),
    resource_events: () => new Promise(() => {}),
    ...over,
  });
  const list = async (plural: string, items: KubeObject[]) => {
    await act(async () => {
      subs.get(plural)?.({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  };
  return { ...topology, list };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

async function show(f = fake(), resources = RESOURCES) {
  const context: ClusterOutletContext = {
    clusterId: "c1",
    resources,
    resourcesLoading: false,
    resourcesError: null,
  };
  const view = render(
    <MemoryRouter initialEntries={["/cluster/c1"]}>
      <Routes>
        <Route path="/cluster/:id" element={<Outlet context={context} />}>
          <Route
            index
            element={
              <>
                <ClusterHome
                  clusterId="c1"
                  clusterName="kind-dev"
                  info={INFO}
                />
                <Where />
              </>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
  await act(flush);
  return { f, unmount: view.unmount };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const href = (id: string) => screen.getByTestId(id).getAttribute("href");

function kube(
  plural: string,
  name: string,
  rest: Record<string, unknown> = {},
): KubeObject {
  return {
    metadata: {
      name,
      namespace: "shop",
      uid: `${plural}/${name}`,
      resourceVersion: "1",
    },
    ...rest,
  } as KubeObject;
}

beforeEach(() => {
  resetTopologyForTest();
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  resetTopConsumersForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("the Overview lays out Capacity and Health, then Cluster and Top consumers, then Metrics", async () => {
  await show();
  const cells = [...screen.getByTestId("overview-grid").children];
  expect(
    cells.map((c) => [
      c.getAttribute("data-span"),
      c.firstElementChild?.getAttribute("data-testid"),
    ]),
  ).toEqual([
    ["5", "overview-capacity"],
    ["7", "overview-health"],
    ["4", "overview-cluster"],
    ["8", "overview-top"],
    ["12", "overview-metrics"],
  ]);
  const cluster = screen.getByTestId("overview-cluster");
  expect(within(cluster).getByTestId("cluster-info-version").textContent).toBe(
    "v1.33.1",
  );
  expect(within(cluster).getByTestId("control-plane")).toBeTruthy();
});

test("Capacity sums the topology with metrics-server, and Top consumers and Metrics share its totals", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  expect(text("overview-capacity-cpu-values")).toBe("2 / 8 cores");
  expect(text("overview-capacity-cpu-note")).toBe("Requests 38%");
  expect(text("overview-capacity-memory-values")).toBe("8 / 32 GiB");
  expect(text("overview-capacity-pods-values")).toBe("2 / 220 pods");
  expect(text("overview-capacity-caption")).toBe(
    "CPU and memory: usage from metrics-server",
  );

  const kafka = screen.getByTestId("overview-top-pods-row-ingest/kafka-0");
  expect(kafka.textContent).toContain("1.2 cores");
  expect(within(kafka).getByRole("img").getAttribute("aria-label")).toBe(
    "kafka-0 15% of the cluster's CPU",
  );
  expect(
    within(screen.getByTestId("metrics-chart-cpu")).getByText(
      "of 8 cores on 2 nodes",
    ),
  ).toBeTruthy();
});

test("Health counts the lists in the chosen namespaces, and each tile links to its list", async () => {
  const { f } = await show(
    fake({
      ui_state_get: (a: { key: string }) =>
        a.key === "namespaces:c1" ? ["shop"] : null,
    }),
  );
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  const asked = f.backend
    .callsTo("resources_subscribe")
    .map((a): [string, unknown] => [
      (a.resource as ResourceRef).plural,
      a.namespaces,
    ])
    .sort(([a], [b]) => a.localeCompare(b));
  expect(asked).toEqual(
    [
      "cronjobs",
      "daemonsets",
      "deployments",
      "events",
      "jobs",
      "pods",
      "replicasets",
      "statefulsets",
    ].map((p) => [p, ["shop"]]),
  );
  expect(text("overview-health-namespaces")).toBe("In namespace: shop");
  expect(text("overview-tile-pods-sub")).toBe("Loading");

  await f.list("pods", [
    kube("pods", "api-0", { status: { phase: "Running" } }),
    kube("pods", "web-1", {
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "c", state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    }),
  ]);
  for (const plural of WORKLOAD_PLURALS) await f.list(plural, []);
  const seen = Date.now() - 120_000;
  await f.list("events", [
    kube("events", "e1", {
      type: "Warning",
      reason: "BackOff",
      lastTimestamp: new Date(seen).toISOString(),
    }),
  ]);

  expect(text("overview-tile-nodes-number")).toBe("2 / 2");
  expect(text("overview-tile-pods-number")).toBe("2");
  expect(text("overview-tile-pods-sub")).toBe(
    "1 Running · 0 Pending · 1 Failed",
  );
  expect(
    screen.getByTestId("overview-tile-pods").getAttribute("data-tone"),
  ).toBe("danger");
  expect(text("overview-tile-workloads-sub")).toBe("All healthy");
  expect(text("overview-tile-events-number")).toBe("1");
  // Two minutes, and the few milliseconds the test took since.
  expect(text("overview-tile-events-sub")).toMatch(
    /^Latest: BackOff, 2m(\d+s)? ago$/,
  );
  expect(
    ["nodes", "pods", "workloads", "events"].map((id) =>
      href(`overview-tile-${id}`),
    ),
  ).toEqual([
    "/cluster/c1/r/core/nodes",
    "/cluster/c1/r/core/pods",
    "/cluster/c1/workloads",
    "/cluster/c1/r/core/events",
  ]);
});

test("nodes the account may not list: no capacity, a disabled Nodes tile and no top consumers", async () => {
  const forbidden = RESOURCES.map((r) =>
    r.resource.plural === "nodes" ? { ...r, canList: false } : r,
  );
  await show(fake(), forbidden);
  expect(text("overview-capacity-caption")).toBe(
    "Capacity is not shown: your account may not list nodes, so allocatable cannot be summed.",
  );
  expect(text("overview-capacity-cpu-values")).toBe("No data");
  const nodes = screen.getByTestId("overview-tile-nodes") as HTMLButtonElement;
  expect(nodes.disabled).toBe(true);
  expect(text("overview-tile-nodes-sub")).toBe("You may not list nodes");
  expect(
    within(screen.getByTestId("overview-top-empty")).getByRole("heading")
      .textContent,
  ).toBe("Top consumers are not shown");
  expect(screen.queryByTestId("overview-top-by")).toBeNull();
});

test("without metrics.k8s.io, Capacity reads the requests and Top consumers needs metrics-server", async () => {
  const { f } = await show(
    fake({
      metrics_usage: () => {
        throw NO_METRICS_SERVER;
      },
    }),
  );
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  await act(flush);
  expect(text("overview-capacity-caption")).toBe(
    "CPU and memory: requests, metrics unavailable",
  );
  expect(text("overview-capacity-cpu-values")).toBe("3 / 8 cores");
  expect(screen.queryByTestId("overview-capacity-cpu-note")).toBeNull();
  const empty = screen.getByTestId("overview-top-empty");
  expect(within(empty).getByRole("heading").textContent).toBe(
    "Top consumers need metrics-server",
  );
  expect(empty.textContent).toContain(
    "This cluster does not serve the metrics API (metrics.k8s.io), so usage by namespace and Pod is unknown.",
  );
});

test("a top row opens its Pod's drawer over the Overview, and a namespace row its Namespace's", async () => {
  const { f } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  fireEvent.click(screen.getByTestId("overview-top-pods-open-ingest/kafka-0"));
  expect(text("where")).toBe("/cluster/c1?open=pods&object=ingest%2Fkafka-0");
  await act(flush);
  expect(text("detail-title")).toBe("kafka-0");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe("/cluster/c1");

  fireEvent.click(screen.getByTestId("overview-top-namespaces-open-shop"));
  expect(text("where")).toBe("/cluster/c1?open=namespaces&object=%2Fshop");
  await act(flush);
  expect(text("detail-kind")).toBe("Namespace");
});

test("the CPU or Memory choice of Top consumers is kept when the Overview opens again", async () => {
  const { f, unmount } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  expect(
    screen.getByTestId("overview-top-pods-row-ingest/kafka-0").textContent,
  ).toContain("3.4Gi");
  unmount();
  await show();
  expect(
    (screen.getByRole("radio", { name: "Memory" }) as HTMLInputElement).checked,
  ).toBe(true);
});
