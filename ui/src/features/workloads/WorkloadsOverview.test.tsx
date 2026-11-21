import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { noProvider } from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import type { ClusterOutletContext } from "../cluster/ClusterLayout";
import { WorkloadsOverview } from "./WorkloadsOverview";

function info(
  group: string,
  plural: string,
  kind: string,
  over: Partial<ApiResourceInfo> = {},
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
    ...over,
  };
}

const PODS = info("", "pods", "Pod");
const DEPLOYMENTS = info("apps", "deployments", "Deployment");
const DAEMONSETS = info("apps", "daemonsets", "DaemonSet");
const STATEFULSETS = info("apps", "statefulsets", "StatefulSet");
const REPLICASETS = info("apps", "replicasets", "ReplicaSet");
const JOBS = info("batch", "jobs", "Job");
const CRONJOBS = info("batch", "cronjobs", "CronJob");
const EVENTS = info("", "events", "Event");
/** Served, so an event about a Node opens it; the page never watches Nodes. */
const NODES = info("", "nodes", "Node", {
  resource: {
    group: "",
    version: "v1",
    plural: "nodes",
    kind: "Node",
    namespaced: false,
  },
});
const ALL = [
  PODS,
  DEPLOYMENTS,
  DAEMONSETS,
  STATEFULSETS,
  REPLICASETS,
  JOBS,
  CRONJOBS,
  EVENTS,
  NODES,
];

function fakeBackend(uiState: Record<string, unknown> = {}) {
  const subs = new Map<string, (event: WatchEvent) => void>();
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) => uiState[a.key] ?? null,
    ui_state_set: (a: { key: string; value: unknown }) => {
      uiState[a.key] = a.value;
      return null;
    },
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
    metrics_provider: () => noProvider(),
  });
  async function send(plural: string, event: WatchEvent) {
    await act(async () => {
      subs.get(plural)?.(event);
      await flush();
    });
  }
  async function snapshot(plural: string, items: KubeObject[]) {
    await send(plural, { type: "snapshot", items } as WatchEvent);
  }
  const subscribed = () =>
    backend
      .callsTo("resources_subscribe")
      .map((a) => (a.resource as ResourceRef).plural);
  /** What each subscription named, sorted by plural: the plural and the namespaces. */
  const askedFor = () =>
    backend
      .callsTo("resources_subscribe")
      .map((a): [string, string[]] => [
        (a.resource as ResourceRef).plural,
        a.namespaces as string[],
      ])
      .sort(([a], [b]) => a.localeCompare(b));
  return { backend, uiState, send, snapshot, subscribed, askedFor };
}

type Fake = ReturnType<typeof fakeBackend>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

async function show(
  resources: ApiResourceInfo[] = ALL,
  over: Partial<ClusterOutletContext> = {},
) {
  const context: ClusterOutletContext = {
    clusterId: "c1",
    resources,
    resourcesLoading: false,
    resourcesError: null,
    ...over,
  };
  render(
    <MemoryRouter initialEntries={["/cluster/c1/workloads"]}>
      <Routes>
        <Route path="/cluster/:id" element={<Outlet context={context} />}>
          <Route
            path="workloads"
            element={
              <>
                <WorkloadsOverview />
                <Where />
              </>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
}

/** What the page watches, sorted. */
const WATCHED = [
  "cronjobs",
  "daemonsets",
  "deployments",
  "events",
  "jobs",
  "pods",
  "replicasets",
  "statefulsets",
];

/** Every watched kind's first list, empty unless given. */
async function snapshots(fake: Fake, lists: Record<string, KubeObject[]>) {
  for (const plural of WATCHED) {
    await fake.snapshot(plural, lists[plural] ?? []);
  }
}

function pod(
  name: string,
  namespace: string,
  state: "running" | "pending" | "crashing" | "terminating",
): KubeObject {
  const running = { name: "app", ready: true, state: { running: {} } };
  const statuses = {
    running: { phase: "Running", containerStatuses: [running] },
    pending: { phase: "Pending" },
    crashing: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          ready: false,
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    },
    terminating: { phase: "Running", containerStatuses: [running] },
  };
  return {
    metadata: {
      name,
      namespace,
      ...(state === "terminating"
        ? { deletionTimestamp: "2026-11-14T00:00:00Z" }
        : {}),
    },
    spec: { containers: [{ name: "app" }] },
    status: statuses[state],
  };
}

const availableDeployment = (name: string, namespace: string): KubeObject => ({
  metadata: { name, namespace },
  spec: { replicas: 1 },
  status: {
    readyReplicas: 1,
    updatedReplicas: 1,
    conditions: [{ type: "Available", status: "True" }],
  },
});

const scaledDownDeployment = (name: string, namespace: string): KubeObject => ({
  metadata: { name, namespace },
  spec: { replicas: 0 },
  status: {},
});

const stalledDeployment = (name: string, namespace: string): KubeObject => ({
  metadata: { name, namespace },
  spec: { replicas: 2 },
  status: {
    conditions: [
      {
        type: "Progressing",
        status: "False",
        reason: "ProgressDeadlineExceeded",
      },
    ],
  },
});

function event(
  name: string,
  over: {
    namespace?: string;
    minutes?: number;
    type?: string;
    reason?: string;
    message?: string;
    involved?: Record<string, string>;
  } = {},
): KubeObject {
  const namespace = over.namespace ?? "default";
  return {
    metadata: { name, namespace, uid: name },
    type: over.type ?? "Normal",
    reason: over.reason ?? "Started",
    involvedObject: over.involved ?? {
      apiVersion: "v1",
      kind: "Pod",
      name: `pod-${name}`,
      namespace,
    },
    message: over.message ?? `message ${name}`,
    lastTimestamp: new Date(
      Date.now() - (over.minutes ?? 1) * 60_000,
    ).toISOString(),
  };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const href = (id: string) => screen.getByTestId(id).getAttribute("href");
/** A table's row keys, in order. */
const rowKeys = (table: string) =>
  screen
    .getAllByTestId(new RegExp(`^${table}-row-`))
    .map((r) => r.getAttribute("data-testid")?.slice(`${table}-row-`.length));
/** A row's cells' texts, its name first: the name may be a row header or a cell. */
const rowCells = (id: string) => {
  const row = within(screen.getByTestId(id));
  return [
    ...row.queryAllByRole("rowheader"),
    ...row.queryAllByRole("cell"),
  ].map((c) => c.textContent);
};
/** A row's cells after its name. */
const cells = (id: string) => rowCells(id).slice(1);
const heads = (table: string) =>
  within(screen.getByTestId(table))
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
const tile = (id: string) => [
  text(`overview-tile-${id}-number`),
  text(`overview-tile-${id}-sub`),
  screen.getByTestId(`overview-tile-${id}`).getAttribute("data-tone"),
];

beforeEach(() => {
  resetResourcesForTest();
  resetMetricsForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "one" });
});
afterEach(() => {
  resetResourcesForTest();
  resetCatalogForTest();
});

test("the page is titled Workloads overview, with the kinds, then Health beside Workloads with problems, then Recent events", async () => {
  fakeBackend();
  await show();
  expect(text("workloads-overview-title")).toBe("Workloads overview");
  expect(screen.getByTestId("workloads-overview")).toBeTruthy();
  const grid = screen.getByTestId("workloads-overview-card-kinds").parentElement
    ?.parentElement as HTMLElement;
  expect(
    [...grid.children].map((c) => [
      c.getAttribute("data-span"),
      c.firstElementChild?.getAttribute("data-testid"),
    ]),
  ).toEqual([
    ["12", "workloads-overview-card-kinds"],
    ["5", "workloads-overview-card-health"],
    ["7", "workloads-overview-card-problems"],
    ["12", "workloads-overview-card-events"],
  ]);
  // No namespace is chosen in the lists, so there is no note.
  expect(screen.queryByTestId("workloads-overview-namespaces")).toBeNull();
});

test("each kind's tile counts its objects by their list's status, in the sidebar's order, and links to its list", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {
    pods: [
      pod("a", "shop", "running"),
      pod("b", "shop", "pending"),
      pod("c", "shop", "crashing"),
      pod("d", "shop", "terminating"),
    ],
    deployments: [availableDeployment("web", "shop")],
  });

  const card = screen.getByTestId("workloads-overview-card-kinds");
  expect(
    within(card)
      .getAllByRole("link")
      .map((a) => a.getAttribute("data-testid")),
  ).toEqual([
    "overview-tile-pods",
    "overview-tile-deployments",
    "overview-tile-daemonsets",
    "overview-tile-statefulsets",
    "overview-tile-replicasets",
    "overview-tile-jobs",
    "overview-tile-cronjobs",
  ]);
  // The Terminating Pod counts only in the number.
  expect(tile("pods")).toEqual(["4", "1 failing · 1 pending", "danger"]);
  expect(tile("deployments")).toEqual(["1", "All healthy", "ok"]);
  expect(tile("cronjobs")).toEqual(["0", "None", "neutral"]);
  expect(href("overview-tile-pods")).toBe("/cluster/c1/r/core/pods");
  expect(href("overview-tile-deployments")).toBe(
    "/cluster/c1/r/apps/deployments",
  );
  expect(href("overview-tile-cronjobs")).toBe("/cluster/c1/r/batch/cronjobs");
});

test("a kind still loading, forbidden or not served reads a dash with its reason, and the rest still count", async () => {
  const fake = fakeBackend();
  await show([
    PODS,
    DEPLOYMENTS,
    DAEMONSETS,
    STATEFULSETS,
    REPLICASETS,
    { ...JOBS, canList: false },
    EVENTS,
  ]);
  await fake.send("daemonsets", {
    type: "status",
    status: "forbidden",
    message: "daemonsets is forbidden",
  });
  await fake.snapshot("pods", [pod("a", "shop", "running")]);

  // A kind that may not be listed, or is not served, is not even watched.
  expect(fake.subscribed()).not.toContain("jobs");
  expect(fake.subscribed()).not.toContain("cronjobs");
  expect(tile("pods")).toEqual(["1", "All healthy", "ok"]);
  expect(tile("deployments")).toEqual(["—", "Loading", "neutral"]);
  expect(href("overview-tile-deployments")).toBe(
    "/cluster/c1/r/apps/deployments",
  );
  expect(tile("daemonsets")).toEqual([
    "—",
    "You may not list DaemonSets",
    "neutral",
  ]);
  expect(tile("jobs")).toEqual(["—", "You may not list Jobs", "neutral"]);
  expect(tile("cronjobs")).toEqual([
    "—",
    "This cluster does not serve CronJobs",
    "neutral",
  ]);
  for (const id of ["daemonsets", "jobs", "cronjobs"]) {
    const button = screen.getByTestId(`overview-tile-${id}`);
    expect(button.tagName).toBe("BUTTON");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  // The cards wait for the kind that still loads.
  expect(screen.getByTestId("workloads-health-loading")).toBeTruthy();
  expect(screen.getByTestId("workloads-problems-loading")).toBeTruthy();
});

test("while discovery runs, every tile and table is loading", async () => {
  fakeBackend();
  await show([], { resourcesLoading: true });
  for (const id of ["pods", "jobs", "cronjobs"]) {
    expect(text(`overview-tile-${id}-sub`)).toBe("Loading");
  }
  expect(screen.getByTestId("workloads-health-loading")).toBeTruthy();
  expect(screen.getByTestId("workloads-problems-loading")).toBeTruthy();
  expect(screen.getByTestId("workloads-events-loading")).toBeTruthy();
  expect(screen.queryByTestId("overview-capacity-healthy")).toBeNull();
});

test("Health shows the healthy share of the listed kinds and each kind's counts", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {
    pods: [
      pod("a", "shop", "running"),
      pod("b", "shop", "pending"),
      pod("c", "shop", "crashing"),
      pod("d", "shop", "terminating"),
    ],
    deployments: [
      availableDeployment("web", "shop"),
      scaledDownDeployment("idle", "shop"),
    ],
  });

  // Healthy is all but pending and failing: the Terminating Pod and the scaled-down
  // Deployment count as healthy.
  const donut = screen.getByTestId("overview-capacity-healthy");
  expect(within(donut).getByRole("img").getAttribute("aria-label")).toMatch(
    /^Healthy workloads 67%, 4 of 6$/,
  );
  expect(text("overview-capacity-healthy-values")).toBe("4 / 6");
  expect(text("overview-capacity-healthy-note")).toBe("1 pending · 1 failing");

  expect(heads("workloads-health")).toEqual([
    "Kind",
    "Healthy",
    "Pending",
    "Failing",
  ]);
  expect(rowKeys("workloads-health")).toEqual([
    "pods",
    "deployments",
    "daemonsets",
    "statefulsets",
    "replicasets",
    "jobs",
    "cronjobs",
  ]);
  expect(cells("workloads-health-row-pods")).toEqual(["2", "1", "1"]);
  expect(cells("workloads-health-row-deployments")).toEqual(["2", "0", "0"]);
  expect(cells("workloads-health-row-cronjobs")).toEqual(["0", "0", "0"]);
});

test("with no kind to list, Health and Workloads with problems say so", async () => {
  fakeBackend();
  await show([EVENTS]);
  expect(text("overview-tile-pods-sub")).toBe(
    "This cluster does not serve Pods",
  );
  expect(screen.queryByTestId("overview-capacity-healthy")).toBeNull();
  expect(text("workloads-health-empty")).toContain(
    "You may not list workloads",
  );
  expect(text("workloads-problems-empty")).toContain(
    "You may not list workloads",
  );
});

test("Workloads with problems puts failing first, then sorts by namespace and name, and a row opens its drawer", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {
    pods: [
      pod("web-2", "shop", "pending"),
      pod("api-0", "shop", "crashing"),
      pod("web-1", "default", "pending"),
      pod("ok-0", "shop", "running"),
    ],
    deployments: [stalledDeployment("web", "shop")],
  });

  expect(heads("workloads-problems")).toEqual(["Workload", "Kind", "Status"]);
  expect(rowKeys("workloads-problems")).toEqual([
    "pods/shop/api-0",
    "deployments/shop/web",
    "pods/default/web-1",
    "pods/shop/web-2",
  ]);
  expect(rowCells("workloads-problems-row-pods/shop/api-0")[0]).toContain(
    "shop",
  );
  expect(cells("workloads-problems-row-pods/shop/api-0")).toEqual([
    "Pod",
    "CrashLoopBackOff",
  ]);
  expect(cells("workloads-problems-row-deployments/shop/web")).toEqual([
    "Deployment",
    "Stalled",
  ]);
  expect(cells("workloads-problems-row-pods/default/web-1")).toEqual([
    "Pod",
    "Pending",
  ]);
  expect(screen.queryByTestId("workloads-problems-footer")).toBeNull();

  fireEvent.click(
    screen.getByTestId("workloads-problems-open-pods/shop/api-0"),
  );
  expect(text("where")).toBe(
    "/cluster/c1/workloads?open=pods&object=shop%2Fapi-0",
  );
  await act(flush);
  expect(text("detail-title")).toBe("api-0");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe("/cluster/c1/workloads");

  fireEvent.click(
    screen.getByTestId("workloads-problems-open-deployments/shop/web"),
  );
  expect(text("where")).toBe(
    "/cluster/c1/workloads?open=deployments.apps&object=shop%2Fweb",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("Deployment");
});

test("past fifty problems the card says how many there are", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {
    pods: Array.from({ length: 51 }, (_, i) =>
      pod(`p-${i}`, "shop", "crashing"),
    ),
  });
  expect(rowKeys("workloads-problems")).toHaveLength(50);
  expect(text("workloads-problems-footer")).toBe(
    "Showing 50 of 51. The lists show them all.",
  );
});

test("with nothing failing or pending, every workload is healthy", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {
    pods: [pod("a", "shop", "running")],
    deployments: [availableDeployment("web", "shop")],
  });
  expect(text("workloads-problems-empty")).toContain(
    "Every workload is healthy",
  );
});

test("Recent events shows the eight newest, and an event opens the object it names when discovery lists its kind", async () => {
  const fake = fakeBackend();
  await show();
  const events = Array.from({ length: 10 }, (_, i) =>
    event(`e${i}`, { minutes: 20 - i }),
  );
  events[9] = event("e9", {
    minutes: 2,
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container api",
    involved: {
      apiVersion: "v1",
      kind: "Pod",
      name: "api-0",
      namespace: "default",
    },
  });
  events[8] = event("e8", {
    minutes: 3,
    involved: {
      apiVersion: "example.com/v1",
      kind: "Widget",
      name: "w-1",
      namespace: "default",
    },
  });
  events[7] = event("e7", {
    minutes: 4,
    reason: "NodeReady",
    involved: { apiVersion: "v1", kind: "Node", name: "n1" },
  });
  await snapshots(fake, { events });

  expect(heads("workloads-events")).toEqual([
    "Object",
    "Type",
    "Message",
    "Age",
  ]);
  expect(rowKeys("workloads-events")).toEqual([
    "e9",
    "e8",
    "e7",
    "e6",
    "e5",
    "e4",
    "e3",
    "e2",
  ]);
  const [object, ...rest] = rowCells("workloads-events-row-e9");
  expect(object).toContain("api-0");
  expect(object).toContain("Pod · BackOff");
  expect(rest.slice(0, 2)).toEqual([
    "Warning",
    "Back-off restarting failed container api",
  ]);
  // Two minutes, and the few milliseconds the test took since.
  expect(rest[2]).toMatch(/^2m(\d+s)?$/);
  expect(cells("workloads-events-row-e8")[0]).toBe("Normal");
  // A kind discovery does not list is plain text.
  expect(text("workloads-events-row-e8")).toContain("w-1");
  expect(screen.queryByTestId("workloads-events-open-e8")).toBeNull();

  fireEvent.click(screen.getByTestId("workloads-events-open-e9"));
  expect(text("where")).toBe(
    "/cluster/c1/workloads?open=pods&object=default%2Fapi-0",
  );
  await act(flush);
  expect(text("detail-title")).toBe("api-0");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);

  // An event about a Node opens the Node, which has no namespace.
  fireEvent.click(screen.getByTestId("workloads-events-open-e7"));
  expect(text("where")).toBe("/cluster/c1/workloads?open=nodes&object=%2Fn1");
  await act(flush);
  expect(text("detail-kind")).toBe("Node");
});

test("with no event, Recent events says so", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {});
  const empty = text("workloads-events-empty");
  expect(empty).toContain("No recent events");
  expect(empty).toContain("Events of the selected namespaces show here.");
});

test("events that may not be listed say so and leave the kinds alone", async () => {
  const fake = fakeBackend();
  await show();
  await fake.send("events", {
    type: "status",
    status: "forbidden",
    message: "events is forbidden",
  });
  await snapshots(fake, { pods: [pod("a", "shop", "running")] });
  expect(text("workloads-events-empty")).toContain("You may not list events");
  expect(tile("pods")).toEqual(["1", "All healthy", "ok"]);
});

test("the namespaces chosen in the lists show as a note, and only they are asked for and counted", async () => {
  const fake = fakeBackend({ "namespaces:c1": ["team-a", "team-b"] });
  await show();
  await waitFor(() =>
    expect(text("workloads-overview-namespaces")).toContain(
      "Namespaces: team-a, team-b",
    ),
  );
  // Never every namespace first.
  expect(fake.askedFor()).toEqual(
    WATCHED.map((plural) => [plural, ["team-a", "team-b"]]),
  );
  await snapshots(fake, {
    pods: [
      pod("a", "team-a", "running"),
      pod("b", "team-b", "crashing"),
      pod("c", "team-c", "crashing"),
    ],
    events: [event("ea", { namespace: "team-a" })],
  });
  expect(tile("pods")).toEqual(["2", "1 failing", "danger"]);
  expect(rowKeys("workloads-events")).toEqual(["ea"]);
});

test("with no namespace chosen, every namespace is asked for", async () => {
  const fake = fakeBackend();
  await show();
  expect(fake.askedFor()).toEqual(WATCHED.map((plural) => [plural, []]));
});
