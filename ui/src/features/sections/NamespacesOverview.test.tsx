import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
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
  noProvider,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import {
  CONNECTED,
  connectClusters,
  setClusterState,
} from "../../test/terminal";
import {
  GIB,
  tnode,
  topologyBackend,
  tregion,
  tsnapshot,
  tzone,
} from "../../test/topology";
import type { ClusterOutletContext } from "../cluster/ClusterLayout";
import {
  NamespacesOverview,
  resetNamespacesOverviewForTest,
} from "./NamespacesOverview";

const RESOURCES: ApiResourceInfo[] = [
  servedResource("Namespace", "", "namespaces", false),
  servedResource("ResourceQuota", "", "resourcequotas"),
  servedResource("LimitRange", "", "limitranges"),
  servedResource("Pod", "", "pods"),
  servedResource("Deployment", "apps", "deployments"),
  servedResource("StatefulSet", "apps", "statefulsets"),
  servedResource("DaemonSet", "apps", "daemonsets"),
  servedResource("Job", "batch", "jobs"),
  servedResource("CronJob", "batch", "cronjobs"),
  servedResource("Node", "", "nodes", false),
];

/** One node of 4 cores and 16 GiB: shares are of those. */
const SNAPSHOT = tsnapshot([tregion(null, [tzone(null, [tnode("n1")])])]);
/** payments uses 2 cores and 3 GiB in two Pods, checkout 0.5 cores and 4 GiB in one. */
const POD_USAGE = usageSnapshot([
  usageItem({
    namespace: "payments",
    name: "api-0",
    cpuCores: 1.2,
    memoryBytes: 2 * GIB,
  }),
  usageItem({
    namespace: "payments",
    name: "api-1",
    cpuCores: 0.8,
    memoryBytes: 1 * GIB,
  }),
  usageItem({
    namespace: "checkout",
    name: "web-0",
    cpuCores: 0.5,
    memoryBytes: 4 * GIB,
  }),
]);

function fake(
  over: Record<string, (a: never) => unknown> = {},
  uiState: Record<string, unknown> = {},
) {
  const subs = new Map<string, (e: WatchEvent) => void>();
  const topology = topologyBackend({
    ui_state_get: (a: { key: string }) => uiState[a.key] ?? null,
    ui_state_set: () => null,
    metrics_provider: () => metricsServer(),
    metrics_usage: () => POD_USAGE,
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
  /** What each subscription named, sorted by plural: the plural and the namespaces. */
  const asked = () =>
    topology.backend
      .callsTo("resources_subscribe")
      .map((a): [string, unknown] => [
        (a.resource as ResourceRef).plural,
        a.namespaces,
      ])
      .sort(([a], [b]) => a.localeCompare(b));
  return { ...topology, list, asked };
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
    <MemoryRouter initialEntries={["/cluster/c1/namespaces"]}>
      <Routes>
        <Route path="/cluster/:id" element={<Outlet context={context} />}>
          <Route
            path="namespaces"
            element={
              <>
                <NamespacesOverview />
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
const tone = (id: string) => screen.getByTestId(id).getAttribute("data-tone");
const rowIds = (table: string) =>
  screen
    .getAllByTestId(new RegExp(`^${table}-row-`))
    .map((r) => r.getAttribute("data-testid"));
/** The heading named `name` inside the element `id`; throws when there is none. */
const heading = (id: string, name: string) =>
  within(screen.getByTestId(id)).getByRole("heading", { name });

function obj(
  plural: string,
  namespace: string,
  name: string,
  rest: Record<string, unknown> = {},
): KubeObject {
  return {
    metadata: {
      name,
      namespace,
      uid: `${plural}/${namespace}/${name}`,
      resourceVersion: "1",
    },
    ...rest,
  } as KubeObject;
}

function ns(name: string, phase = "Active"): KubeObject {
  return {
    metadata: { name, uid: `namespaces/${name}`, resourceVersion: "1" },
    status: { phase },
  } as KubeObject;
}

function quota(
  namespace: string,
  name: string,
  hard: Record<string, string>,
  used: Record<string, string>,
): KubeObject {
  return obj("resourcequotas", namespace, name, {
    spec: { hard },
    status: { hard, used },
  });
}

beforeEach(() => {
  resetTopologyForTest();
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  resetNamespacesOverviewForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("the page lays out Top namespaces and Summary, then Quota usage, then Pods and workloads per namespace", async () => {
  await show();
  expect(text("namespaces-overview-title")).toBe("Namespaces overview");
  expect(screen.queryByTestId("namespaces-overview-namespaces")).toBeNull();
  const cells = [
    ...screen
      .getByTestId("namespaces-overview")
      .querySelectorAll("[data-span]"),
  ];
  expect(
    cells.map((c) => [
      c.getAttribute("data-span"),
      c.firstElementChild?.getAttribute("data-testid"),
    ]),
  ).toEqual([
    ["5", "namespaces-overview-card-top"],
    ["7", "namespaces-overview-card-summary"],
    ["12", "namespaces-overview-card-quotas"],
    ["12", "namespaces-overview-card-per-namespace"],
  ]);
  for (const name of [
    "Top namespaces",
    "Summary",
    "Quota usage",
    "Pods and workloads per namespace",
  ]) {
    expect(screen.getByRole("region", { name })).toBeTruthy();
  }
});

test("the namespaces chosen in the lists show as a note, and every namespaced list is asked for them", async () => {
  const f = fake({}, { "namespaces:c1": ["payments", "checkout"] });
  await show(f);
  expect(text("namespaces-overview-namespaces")).toBe(
    "Namespaces: payments, checkout",
  );
  const chosen = ["checkout", "payments"];
  expect(f.asked()).toEqual([
    ["cronjobs", chosen],
    ["daemonsets", chosen],
    ["deployments", chosen],
    ["jobs", chosen],
    ["limitranges", chosen],
    ["namespaces", []],
    ["pods", chosen],
    ["resourcequotas", chosen],
    ["statefulsets", chosen],
  ]);
});

test("Summary counts the Namespaces, the Terminating ones and the namespaces with a quota or a limit, each tile opening its list", async () => {
  const f = fake();
  await show(f);
  expect(text("overview-tile-namespaces-sub")).toBe("Loading");
  await f.list("namespaces", [
    ns("default"),
    ns("payments"),
    ns("old-1", "Terminating"),
    ns("old-2", "Terminating"),
  ]);
  await f.list("resourcequotas", [
    quota("payments", "compute", { pods: "10" }, { pods: "1" }),
    quota("payments", "objects", { pods: "10" }, { pods: "1" }),
    quota("default", "small", { pods: "10" }, { pods: "1" }),
  ]);
  await f.list("limitranges", [obj("limitranges", "payments", "defaults")]);
  expect(text("overview-tile-namespaces-number")).toBe("4");
  expect(text("overview-tile-namespaces-sub")).toBe("2 Active · 2 Terminating");
  expect(tone("overview-tile-namespaces")).toBe("ok");
  expect(text("overview-tile-terminating-number")).toBe("2");
  expect(text("overview-tile-terminating-sub")).toBe("old-1, old-2");
  expect(tone("overview-tile-terminating")).toBe("warn");
  expect(text("overview-tile-quota-number")).toBe("2");
  expect(text("overview-tile-quota-sub")).toBe("3 ResourceQuotas");
  expect(text("overview-tile-limits-number")).toBe("1");
  expect(text("overview-tile-limits-sub")).toBe("1 LimitRange");
  expect(
    ["namespaces", "terminating", "quota", "limits"].map((id) =>
      href(`overview-tile-${id}`),
    ),
  ).toEqual([
    "/cluster/c1/r/core/namespaces",
    "/cluster/c1/r/core/namespaces",
    "/cluster/c1/r/core/resourcequotas",
    "/cluster/c1/r/core/limitranges",
  ]);
});

test("a kind the account may not list disables its tile, one the cluster does not serve says so, and Quota usage says you may not list ResourceQuotas", async () => {
  const resources = RESOURCES.filter(
    (r) => r.resource.plural !== "limitranges",
  ).map((r) =>
    r.resource.plural === "resourcequotas" ? { ...r, canList: false } : r,
  );
  await show(fake(), resources);
  const quotaTile = screen.getByTestId(
    "overview-tile-quota",
  ) as HTMLButtonElement;
  expect(quotaTile.disabled).toBe(true);
  expect(text("overview-tile-quota-number")).toBe("—");
  expect(text("overview-tile-quota-sub")).toBe(
    "You may not list ResourceQuotas",
  );
  const limits = screen.getByTestId(
    "overview-tile-limits",
  ) as HTMLButtonElement;
  expect(limits.disabled).toBe(true);
  expect(text("overview-tile-limits-sub")).toBe(
    "This cluster does not serve LimitRanges",
  );
  expect(
    heading("namespaces-quotas-empty", "You may not list ResourceQuotas"),
  ).toBeTruthy();
});

test("Quota usage draws a donut per resource the quota sets, by namespace, and a row opens the quota's drawer", async () => {
  const f = fake();
  await show(f);
  expect(text("namespaces-quotas-loading")).toBe("Loading");
  await f.list("resourcequotas", [
    quota(
      "payments",
      "compute",
      { "requests.cpu": "4", "requests.memory": "8Gi" },
      { "requests.cpu": "2500m", "requests.memory": "2Gi" },
    ),
    quota("checkout", "budget", { pods: "10" }, { pods: "3" }),
  ]);
  expect(rowIds("namespaces-quotas")).toEqual([
    "namespaces-quotas-row-checkout/budget",
    "namespaces-quotas-row-payments/compute",
  ]);
  const compute = screen.getByTestId("namespaces-quotas-row-payments/compute");
  expect(
    within(compute)
      .getAllByRole("img")
      .map((d) => d.getAttribute("aria-label")),
  ).toEqual([
    "payments/compute requests.cpu 63%, 2.5 of 4 cores",
    "payments/compute requests.memory 25%, 2 of 8 GiB",
  ]);
  expect(compute.textContent).toContain("2.5 / 4 cores");
  expect(compute.textContent).toContain("payments");
  expect(within(compute).getByText("—")).toBeTruthy();
  const budget = screen.getByTestId("namespaces-quotas-row-checkout/budget");
  expect(within(budget).getAllByText("—")).toHaveLength(2);
  expect(budget.textContent).toContain("3 / 10 pods");

  fireEvent.click(
    screen.getByTestId("namespaces-quotas-open-payments/compute"),
  );
  expect(text("where")).toBe(
    "/cluster/c1/namespaces?open=resourcequotas&object=payments%2Fcompute",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("ResourceQuota");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe("/cluster/c1/namespaces");
});

test("Quota usage without quotas says so for the chosen namespaces", async () => {
  const f = fake({}, { "namespaces:c1": ["payments", "checkout"] });
  await show(f);
  await f.list("resourcequotas", []);
  expect(heading("namespaces-quotas-empty", "No ResourceQuotas")).toBeTruthy();
  expect(text("namespaces-quotas-empty")).toContain(
    "No ResourceQuota in payments, checkout.",
  );
});

test("Pods and workloads per namespace counts the chosen namespaces that exist, most Pods first, and a row opens its Namespace", async () => {
  const resources = RESOURCES.map((r) =>
    r.resource.plural === "jobs" ? { ...r, canList: false } : r,
  );
  const f = fake({}, { "namespaces:c1": ["payments", "checkout", "gone"] });
  await show(f, resources);
  expect(text("namespaces-per-namespace-loading")).toBe("Loading");
  await f.list("namespaces", [
    ns("default"),
    ns("payments"),
    ns("checkout", "Terminating"),
  ]);
  await f.list("pods", [
    obj("pods", "checkout", "a"),
    obj("pods", "checkout", "b"),
    obj("pods", "payments", "c"),
  ]);
  await f.list("deployments", [obj("deployments", "payments", "api")]);
  for (const plural of ["statefulsets", "daemonsets", "cronjobs"]) {
    await f.list(plural, []);
  }
  expect(rowIds("namespaces-per-namespace")).toEqual([
    "namespaces-per-namespace-row-checkout",
    "namespaces-per-namespace-row-payments",
  ]);
  const checkout = screen.getByTestId("namespaces-per-namespace-row-checkout");
  expect(checkout.textContent).toContain("Terminating");
  // Jobs may not be listed: its column reads a dash.
  expect(within(checkout).getByText("—")).toBeTruthy();
  expect(
    screen.getByTestId("namespaces-per-namespace-row-payments").textContent,
  ).not.toContain("Active");

  fireEvent.click(screen.getByTestId("namespaces-per-namespace-open-checkout"));
  expect(text("where")).toBe(
    "/cluster/c1/namespaces?open=namespaces&object=%2Fcheckout",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("Namespace");
});

test("Top namespaces ranks the namespaces by CPU or memory, keeps the choice, and a row opens its Namespace", async () => {
  const { f, unmount } = await show();
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  await act(flush);
  expect(screen.getByRole("table", { name: "By CPU usage" })).toBe(
    screen.getByTestId("namespaces-top"),
  );
  const payments = screen.getByTestId("namespaces-top-row-payments");
  expect(payments.textContent).toContain("2 cores");
  expect(payments.textContent).toContain("2 pods");
  expect(within(payments).getByRole("img").getAttribute("aria-label")).toBe(
    "payments 50% of the cluster's CPU",
  );

  fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  expect(screen.getByRole("table", { name: "By memory usage" })).toBeTruthy();
  const checkout = screen.getByTestId("namespaces-top-row-checkout");
  expect(checkout.textContent).toContain("4.0Gi");
  expect(within(checkout).getByRole("img").getAttribute("aria-label")).toBe(
    "checkout 25% of the cluster's memory",
  );
  fireEvent.click(screen.getByTestId("namespaces-top-open-checkout"));
  expect(text("where")).toBe(
    "/cluster/c1/namespaces?open=namespaces&object=%2Fcheckout",
  );

  unmount();
  await show();
  expect(
    (screen.getByRole("radio", { name: "Memory" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(screen.getByTestId("namespaces-top-by-memory")).toBeTruthy();
});

test("without metrics.k8s.io Top namespaces needs metrics-server and hides its switch", async () => {
  const { f } = await show(
    fake({
      metrics_usage: () => {
        throw NO_METRICS_SERVER;
      },
    }),
  );
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  await act(flush);
  expect(
    heading("namespaces-top-empty", "Top namespaces need metrics-server"),
  ).toBeTruthy();
  expect(text("namespaces-top-empty")).toContain(
    "This cluster does not serve the metrics API (metrics.k8s.io), so usage by namespace is unknown.",
  );
  expect(screen.queryByTestId("namespaces-top-by")).toBeNull();
  expect(screen.queryByTestId("namespaces-top")).toBeNull();
});

test("with no metrics source Top namespaces says none is set", async () => {
  const { f } = await show(
    fake({ metrics_provider: () => noProvider("setting") }),
  );
  await f.send({ type: "snapshot", snapshot: SNAPSHOT });
  await act(flush);
  expect(
    heading("namespaces-top-empty", "Top namespaces need metrics-server"),
  ).toBeTruthy();
  expect(text("namespaces-top-empty")).toContain(
    "No metrics source is set for this cluster",
  );
});

test("without the right to list namespaces the page says which ones it uses", async () => {
  if (CONNECTED.status !== "connected") throw new Error("not connected");
  setClusterState("c1", {
    status: "connected",
    info: {
      ...CONNECTED.info,
      namespaces: ["payments", "checkout"],
      namespacesRestricted: true,
    },
  });
  const resources = RESOURCES.map((r) =>
    r.resource.plural === "namespaces" ? { ...r, canList: false } : r,
  );
  await show(fake(), resources);
  expect(text("namespaces-overview-title")).toBe("Namespaces overview");
  const denied = screen.getByTestId("namespaces-overview-denied");
  expect(within(denied).getByRole("heading").textContent).toBe(
    "You may not list namespaces",
  );
  expect(denied.textContent).toContain(
    "You may not list this cluster's namespaces, so only these are used: payments, checkout.",
  );
  expect(screen.queryByTestId("namespaces-overview-card-summary")).toBeNull();
});
