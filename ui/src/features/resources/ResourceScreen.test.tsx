import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type ColumnFilter, Toaster } from "../../design";
import { Box } from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { baseColumns, statusColumn, textColumn } from "../../kinds/columns";
import type { KubeObject } from "../../kinds/objects";
import { type DeleteDialogProps, registerKind } from "../../kinds/registry";
import { resetCatalogForTest } from "../../stores/catalog";
import {
  type DetailsDockTab,
  detailsTab,
  resetDockForTest,
  useDock,
} from "../../stores/dock";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { connectClusters } from "../../test/terminal";
import { Dock } from "../dock/Dock";
import { ResourceRoute, ResourceScreen } from "./ResourceScreen";

function info(
  resource: Partial<ResourceRef>,
  over: Partial<ApiResourceInfo> = {},
): ApiResourceInfo {
  return {
    resource: {
      group: "",
      version: "v1",
      plural: "pods",
      kind: "Pod",
      namespaced: true,
      ...resource,
    },
    verbs: ["list", "watch", "delete"],
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

const PODS = info({});
const NODES = info({ plural: "nodes", kind: "Node", namespaced: false });
const DEPLOYMENTS = info({
  group: "apps",
  plural: "deployments",
  kind: "Deployment",
});
const CRDS = info({
  group: "apiextensions.k8s.io",
  plural: "customresourcedefinitions",
  kind: "CustomResourceDefinition",
  namespaced: false,
});
const WIDGETS = info({
  group: "example.com",
  plural: "widgets",
  kind: "Widget",
});

function pod(name: string, namespace = "default"): KubeObject {
  return { metadata: { name, namespace, resourceVersion: "1" } };
}

function labelled(
  name: string,
  labels: Record<string, string>,
  namespace = "ns",
): KubeObject {
  return { metadata: { name, namespace, resourceVersion: "1", labels } };
}

/** Types a filter into the box and adds it with Enter, as its first suggestion. */
function addToken(text: string) {
  const box = screen.getByTestId("resource-search");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

const chipTitles = (el: HTMLElement | null) =>
  within(el as HTMLElement)
    .queryAllByTestId("filter-chip")
    .map((c) => c.title);

/** The saved UI state and the live subscriptions of one fake backend. */
function fakeBackend(
  over: {
    uiState?: Record<string, unknown>;
    subscribe?(resource: ResourceRef): void;
    resourceDelete?(args: {
      name: string;
      namespace: string | null;
      propagation: string;
    }): unknown;
  } = {},
) {
  const uiState = over.uiState ?? {};
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
      over.subscribe?.(a.resource);
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    // A linked object whose list nobody holds is read with a single-object watch.
    resources_subscribe_object: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `object-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    resource_events: () => [],
    resource_delete: (a: {
      name: string;
      namespace: string | null;
      propagation: string;
    }) => (over.resourceDelete ? over.resourceDelete(a) : null),
  });
  async function send(plural: string, event: WatchEvent) {
    await act(async () => {
      subs.get(plural)?.(event);
      await flush();
    });
  }
  return { backend, uiState, subs, send };
}

type Fake = ReturnType<typeof fakeBackend>;

function screenFor(
  clusterId: string,
  resource: ApiResourceInfo,
  resources: ApiResourceInfo[],
) {
  return (
    <MemoryRouter>
      <ResourceScreen
        key={`${clusterId}/${resource.resource.plural}`}
        clusterId={clusterId}
        info={resource}
        resources={resources}
      />
      <Toaster />
    </MemoryRouter>
  );
}

/** Shows a screen and delivers its first rows. */
async function show(
  fake: Fake,
  items: KubeObject[],
  resource: ApiResourceInfo = PODS,
  clusterId = "c1",
  resources: ApiResourceInfo[] = [resource],
) {
  const view = render(screenFor(clusterId, resource, resources));
  await act(flush);
  await fake.send(resource.resource.plural, {
    type: "snapshot",
    items,
  } as WatchEvent);
  await fake.send(resource.resource.plural, {
    type: "status",
    status: "live",
    message: null,
  });
  return view;
}

const row = (namespace: string, name: string) =>
  screen.queryByTestId(`resource-row-${namespace}-${name}`);

function openMenu(testId: string) {
  fireEvent.keyDown(screen.getByTestId(testId), { key: "Enter" });
}

function closeMenu() {
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}

/** Lets a debounced UI state write reach the fake backend. */
async function savedKeys(fake: Fake, count: number) {
  await waitFor(() =>
    expect(Object.keys(fake.uiState).length).toBeGreaterThanOrEqual(count),
  );
}

beforeEach(() => {
  resetResourcesForTest();
  mockElementSize();
});
afterEach(() => {
  resetDockForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  vi.restoreAllMocks();
});

/** The namespaces each subscription to Pods asked for, oldest first. */
const podsAskedFor = (fake: Fake) =>
  fake.backend
    .callsTo("resources_subscribe")
    .filter((c) => (c.resource as ResourceRef).plural === "pods")
    .map((c) => c.namespaces);

test("a table of chosen namespaces asks for those, and never for every namespace first", async () => {
  const fake = fakeBackend({ uiState: { "namespaces:c1": ["team-a"] } });
  await show(fake, [pod("a", "team-a")]);

  expect(row("team-a", "a")).toBeTruthy();
  expect(podsAskedFor(fake)).toEqual([["team-a"]]);
});

test("the Pods behind Deployments are asked for the chosen namespaces only, never every namespace first", async () => {
  const fake = fakeBackend({ uiState: { "namespaces:c1": ["team-a"] } });
  await show(fake, [], DEPLOYMENTS);

  expect(podsAskedFor(fake)).toEqual([["team-a"]]);
});

test("choosing a namespace asks for it, and the rows already here stay meanwhile", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("a", "team-a"), pod("b", "team-b")]);
  expect(podsAskedFor(fake)).toEqual([[]]);

  openMenu("namespace-filter");
  fireEvent.click(screen.getByTestId("namespace-option-team-a"));
  closeMenu();
  await act(flush);

  expect(podsAskedFor(fake)).toEqual([[], ["team-a"]]);
  // The new list has sent nothing yet: the table keeps the rows it had, filtered.
  expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
  expect(row("team-a", "a")).toBeTruthy();
  expect(row("team-b", "b")).toBeNull();

  await fake.send("pods", {
    type: "snapshot",
    items: [pod("a", "team-a"), pod("c", "team-a")],
  } as WatchEvent);
  expect(row("team-a", "c")).toBeTruthy();
});

test("the namespace filter offers the cluster's namespaces, with or without rows", async () => {
  connectClusters({ id: "c1", name: "one" });
  const fake = fakeBackend({ uiState: { "namespaces:c1": ["default"] } });
  await show(fake, [pod("a", "default")]);

  openMenu("namespace-filter");
  expect(screen.getByTestId("namespace-option-shop")).toBeTruthy();
});

test("shows loading, then rows, then empty text with the namespace filter's context", async () => {
  const fake = fakeBackend();
  const { unmount } = render(screenFor("c1", PODS, [PODS]));
  await act(flush);
  expect(screen.getByRole("status", { name: /Loading/ })).toBeTruthy();
  expect(screen.queryByTestId("resource-table")).toBeNull();

  await fake.send("pods", {
    type: "snapshot",
    items: [pod("web", "team-a")],
  } as WatchEvent);
  expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
  expect(row("team-a", "web")).toBeTruthy();
  expect(screen.getByTestId("resource-table")).toBeTruthy();

  await fake.send("pods", {
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "team-a", name: "web" }],
  });
  expect(screen.queryByTestId("resource-table")).toBeNull();
  expect(screen.getByText(/no Pod objects in any namespace/i)).toBeTruthy();
  unmount();

  const scoped = fakeBackend({ uiState: { "namespaces:c1": ["team-a"] } });
  resetResourcesForTest();
  await show(scoped, []);
  expect(
    await screen.findByText(/no Pod objects in namespace team-a/i),
  ).toBeTruthy();
});

test("namespace filter persists per cluster and limits rows", async () => {
  const fake = fakeBackend();
  const items = [pod("a", "team-a"), pod("b", "team-b"), pod("c", "team-c")];
  const first = await show(fake, items);

  openMenu("namespace-filter");
  fireEvent.click(screen.getByTestId("namespace-option-team-a"));
  expect(row("team-a", "a")).toBeTruthy();
  expect(row("team-b", "b")).toBeNull();

  // It is a multi-select: the menu stays open and another namespace adds to it.
  fireEvent.click(screen.getByTestId("namespace-option-team-b"));
  expect(row("team-a", "a")).toBeTruthy();
  expect(row("team-b", "b")).toBeTruthy();
  expect(row("team-c", "c")).toBeNull();
  closeMenu();
  expect(screen.getByTestId("namespace-filter").textContent).toContain(
    "2 namespaces",
  );
  await savedKeys(fake, 1);
  first.unmount();
  resetResourcesForTest();

  // Coming back to this cluster, on another kind too, keeps the choice.
  const again = await show(fake, [pod("d", "team-b"), pod("e", "team-c")], {
    ...DEPLOYMENTS,
  });
  await waitFor(() => expect(row("team-c", "e")).toBeNull());
  expect(row("team-b", "d")).toBeTruthy();
  again.unmount();
  resetResourcesForTest();

  // Another cluster has its own.
  await show(fake, items, PODS, "c2");
  await act(flush);
  expect(row("team-c", "c")).toBeTruthy();
  expect(screen.getByTestId("namespace-filter").textContent).toContain(
    "All namespaces",
  );
});

test("All namespaces is the default and cluster-scoped kinds have no filter", async () => {
  const fake = fakeBackend();
  const first = await show(fake, [pod("a", "team-a"), pod("b", "team-b")]);
  const filter = screen.getByTestId("namespace-filter");
  expect(filter.textContent).toContain("All namespaces");
  expect(row("team-a", "a")).toBeTruthy();
  expect(row("team-b", "b")).toBeTruthy();

  // Choosing a namespace and then All shows everything again.
  openMenu("namespace-filter");
  fireEvent.click(screen.getByTestId("namespace-option-team-a"));
  expect(row("team-b", "b")).toBeNull();
  fireEvent.click(screen.getByTestId("namespace-all"));
  expect(row("team-b", "b")).toBeTruthy();
  closeMenu();
  first.unmount();
  resetResourcesForTest();

  await show(fake, [{ metadata: { name: "node-1" } }], NODES);
  expect(screen.queryByTestId("namespace-filter")).toBeNull();
  expect(screen.getByTestId("resource-row-node-1")).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Namespace" })).toBeNull();
});

test("a saved namespace with no objects can still be cleared", async () => {
  const fake = fakeBackend({ uiState: { "namespaces:c1": ["gone"] } });
  await show(fake, [pod("a", "team-a")]);
  await waitFor(() => expect(row("team-a", "a")).toBeNull());
  openMenu("namespace-filter");
  fireEvent.click(screen.getByTestId("namespace-option-gone"));
  expect(row("team-a", "a")).toBeTruthy();
});

test("column visibility persists per kind", async () => {
  const fake = fakeBackend();
  const first = await show(fake, [pod("a")]);
  expect(screen.getByRole("columnheader", { name: /Age/ })).toBeTruthy();

  openMenu("columns-menu");
  fireEvent.click(screen.getByTestId("column-option-age"));
  closeMenu();
  expect(screen.queryByRole("columnheader", { name: /Age/ })).toBeNull();
  await savedKeys(fake, 1);
  first.unmount();
  resetResourcesForTest();

  // Same kind on another cluster: still hidden.
  const again = await show(fake, [pod("a")], PODS, "c2");
  await waitFor(() =>
    expect(screen.queryByRole("columnheader", { name: /Age/ })).toBeNull(),
  );
  openMenu("columns-menu");
  expect(
    screen.getByTestId("column-option-age").getAttribute("aria-checked"),
  ).toBe("false");
  closeMenu();
  again.unmount();
  resetResourcesForTest();

  // Another kind: shown.
  await show(fake, [pod("a")], DEPLOYMENTS);
  await act(flush);
  expect(screen.getByRole("columnheader", { name: /Age/ })).toBeTruthy();
});

test("column widths persist per kind", async () => {
  const fake = fakeBackend();
  const first = await show(fake, [pod("a")]);
  const age = () => screen.getByTestId("column-resize-age");
  fireEvent.keyDown(age(), { key: "ArrowRight" });
  const width = Number(age().getAttribute("aria-valuenow"));
  expect(width).toBeGreaterThan(0);
  await waitFor(() =>
    expect(fake.uiState["column-widths:/pods"]).toEqual({ age: width }),
  );
  first.unmount();
  resetResourcesForTest();

  // Same kind on another cluster: the same width.
  const again = await show(fake, [pod("a")], PODS, "c2");
  await waitFor(() =>
    expect(age().getAttribute("aria-valuenow")).toBe(String(width)),
  );
  again.unmount();
  resetResourcesForTest();

  // Another kind: its own width.
  await show(fake, [pod("a")], DEPLOYMENTS);
  await act(flush);
  expect(age().getAttribute("aria-valuenow")).toBeNull();
});

test("search filters rows", async () => {
  const fake = fakeBackend();
  await show(fake, [
    { metadata: { name: "web", namespace: "a", labels: { app: "web" } } },
    { metadata: { name: "db", namespace: "a", labels: { app: "sql" } } },
  ]);
  const search = screen.getByTestId("resource-search");
  fireEvent.change(search, { target: { value: "app=sql" } });
  expect(row("a", "web")).toBeNull();
  expect(row("a", "db")).toBeTruthy();

  fireEvent.change(search, { target: { value: "absent" } });
  expect(screen.getByText("No Pod objects match the filters.")).toBeTruthy();

  fireEvent.change(search, { target: { value: "" } });
  expect(row("a", "web")).toBeTruthy();
});

test("tokens narrow the rows, the row shows the chips it matched by, two at most, then +n", async () => {
  const fake = fakeBackend();
  await show(fake, [
    labelled("web", {
      app: "web",
      tier: "front",
      team: "a-team",
      zone: "east",
    }),
    labelled("db", { app: "sql" }),
  ]);
  addToken("label:app = web");
  expect(
    screen.getByTestId("filter-token-edit-0").getAttribute("aria-label"),
  ).toBe("Edit filter label:app = web");
  expect(row("ns", "db")).toBeNull();
  expect(chipTitles(row("ns", "web"))).toEqual(["label app=web"]);
  expect(screen.getByTestId("filter-count").textContent).toBe("1 of 2");

  // The typed text narrows as well, and adds the labels its word matched.
  fireEvent.change(screen.getByTestId("resource-search"), {
    target: { value: "a" },
  });
  const web = row("ns", "web") as HTMLElement;
  expect(chipTitles(web)).toEqual(["label app=web", "label team=a-team"]);
  const more = within(web).getByTestId("filter-chip-more");
  expect(more.textContent).toBe("+1");
  expect(more.title).toBe("label zone=east");
});

test("a chip cuts its text after 44 characters and keeps the whole as its title", async () => {
  const fake = fakeBackend();
  const long = "v".repeat(60);
  await show(fake, [labelled("web", { note: long })]);
  addToken("label:note : v");
  const chip = within(row("ns", "web") as HTMLElement).getByTestId(
    "filter-chip",
  );
  expect(chip.title).toBe(`label note=${long}`);
  expect(chip.textContent).toBe(`label${`note=${long}`.slice(0, 44)}…`);
});

test("names, namespaces, != and !: add no chip", async () => {
  const fake = fakeBackend();
  await show(fake, [labelled("web", { app: "web" })]);
  addToken("name = web");
  addToken("namespace : n");
  addToken("label:app != sql");
  addToken("label:tier !:");
  expect(row("ns", "web")).toBeTruthy();
  expect(chipTitles(row("ns", "web"))).toEqual([]);
  expect(screen.queryByTestId("filter-chip-more")).toBeNull();
});

test("when objects exist but none passes, the empty state says the filters match none", async () => {
  const fake = fakeBackend();
  await show(fake, [labelled("web", { app: "web" }), labelled("db", {})]);
  addToken("label:app = absent");
  expect(screen.queryByTestId("resource-table")).toBeNull();
  expect(screen.getByText("No Pod objects match the filters.")).toBeTruthy();
  expect(screen.getByTestId("filter-count").textContent).toBe("0 of 2");

  fireEvent.click(screen.getByTestId("filter-clear"));
  expect(row("ns", "web")).toBeTruthy();
  expect(screen.queryByTestId("filter-tokens")).toBeNull();
  expect(document.activeElement).toBe(screen.getByTestId("resource-search"));
});

test("the suggestions and the count read only the namespaces the namespace filter keeps", async () => {
  const fake = fakeBackend({ uiState: { "namespaces:c1": ["team-a"] } });
  await show(fake, [
    labelled("web", { app: "web" }, "team-a"),
    labelled("db", { role: "sql" }, "team-b"),
  ]);
  const box = screen.getByTestId("resource-search");
  act(() => box.focus());
  const options = within(screen.getByTestId("filter-suggestions"))
    .getAllByRole("option")
    .map((o) => o.firstElementChild?.textContent);
  expect(options).toContain("label:app");
  expect(options).not.toContain("label:role");
  addToken("label:app : w");
  expect(screen.getByTestId("filter-count").textContent).toBe("1 of 1");
});

test("the filter stays while the drawer opens and closes, and the drawer shows no chip", async () => {
  const fake = fakeBackend();
  await show(
    fake,
    [labelled("web", { app: "web" }, "team-a"), labelled("db", {}, "team-a")],
    DEPLOYMENTS,
  );
  addToken("label:app = web");
  fireEvent.change(screen.getByTestId("resource-search"), {
    target: { value: "we" },
  });
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  const drawer = screen.getByTestId("detail-drawer");
  expect(within(drawer).queryAllByTestId("filter-chip")).toEqual([]);
  fireEvent.click(screen.getByTestId("detail-close"));
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(screen.getByTestId("filter-token-0")).toBeTruthy();
  expect(
    (screen.getByTestId("resource-search") as HTMLInputElement).value,
  ).toBe("we");
  expect(row("team-a", "db")).toBeNull();
  expect(chipTitles(row("team-a", "web"))).toEqual(["label app=web"]);
});

test("Escape in the filter box or its edit panel never closes the drawer", async () => {
  const fake = fakeBackend();
  await show(fake, [labelled("web", { app: "web" }, "team-a")], DEPLOYMENTS);
  addToken("label:app = web");
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  const box = screen.getByTestId("resource-search") as HTMLInputElement;
  act(() => box.focus());
  fireEvent.change(box, { target: { value: "we" } });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByTestId("filter-suggestions")).toBeNull();
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
  fireEvent.keyDown(box, { key: "Escape" });
  expect(box.value).toBe("");
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();

  fireEvent.click(screen.getByTestId("filter-token-edit-0"));
  fireEvent.keyDown(screen.getByTestId("filter-edit-value"), {
    key: "Escape",
  });
  expect(screen.queryByTestId("filter-edit")).toBeNull();
  await act(flush);
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
});

test("the sort survives a search that matches nothing", async () => {
  const fake = fakeBackend();
  await show(fake, [
    { metadata: { name: "b", namespace: "a", labels: { app: "web" } } },
    { metadata: { name: "c", namespace: "a", labels: { app: "web" } } },
    { metadata: { name: "a", namespace: "a", labels: { app: "web" } } },
  ]);
  const shownNames = () =>
    screen
      .getAllByTestId(/^resource-row-/)
      .map((el) => (el.dataset.testid ?? "").replace("resource-row-a-", ""));
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(shownNames()).toEqual(["c", "b", "a"]);

  // Typing "app=web" passes through "app=", which only an empty label value matches.
  const search = screen.getByTestId("resource-search");
  fireEvent.change(search, { target: { value: "app=" } });
  expect(screen.queryByTestId("resource-table")).toBeNull();

  fireEvent.change(search, { target: { value: "app=web" } });
  expect(shownNames()).toEqual(["c", "b", "a"]);
  expect(
    screen
      .getByRole("columnheader", { name: "Name" })
      .getAttribute("aria-sort"),
  ).toBe("descending");

  fireEvent.change(search, { target: { value: "" } });
  expect(shownNames()).toEqual(["c", "b", "a"]);
});

test("a Pod recreated under a new name shows in its place, in view, without a sort", async () => {
  const fake = fakeBackend();
  const others = Array.from({ length: 59 }, (_, i) =>
    pod(`p${String(i).padStart(2, "0")}`),
  );
  // As the core sends a snapshot: by namespace, then name.
  await show(fake, [pod("web-aaaaa", "app"), ...others]);
  expect(row("app", "web-aaaaa")?.getAttribute("aria-rowindex")).toBe("2");

  await fake.send("pods", {
    type: "batch",
    upserts: [pod("web-bbbbb", "app")],
    deletes: [{ namespace: "app", name: "web-aaaaa" }],
  } as WatchEvent);
  expect(row("app", "web-aaaaa")).toBeNull();
  expect(row("app", "web-bbbbb")?.getAttribute("aria-rowindex")).toBe("2");
});

test("reconnecting shows an indicator and keeps rows", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("a")]);
  expect(screen.queryByTestId("resource-status")).toBeNull();

  await fake.send("pods", {
    type: "status",
    status: "reconnecting",
    message: "connection lost",
  });
  expect(screen.getByTestId("resource-status").textContent).toMatch(
    /reconnecting/i,
  );
  expect(row("default", "a")).toBeTruthy();

  await fake.send("pods", { type: "status", status: "live", message: null });
  expect(screen.queryByTestId("resource-status")).toBeNull();
  expect(row("default", "a")).toBeTruthy();
});

test("not served and forbidden show an explanation instead of a table", async () => {
  const fake = fakeBackend();
  const first = await show(fake, [pod("a")]);
  await fake.send("pods", {
    type: "status",
    status: "notServed",
    message: null,
  });
  expect(screen.queryByTestId("resource-table")).toBeNull();
  expect(screen.getByTestId("resource-status").textContent).toMatch(
    /no longer serves/,
  );
  first.unmount();
  resetResourcesForTest();

  const denied = fakeBackend();
  await show(denied, [pod("a")]);
  await denied.send("pods", {
    type: "status",
    status: "forbidden",
    message: 'pods is forbidden: User "me" cannot list',
  });
  expect(screen.queryByTestId("resource-table")).toBeNull();
  expect(screen.getByTestId("resource-status").textContent).toContain(
    'pods is forbidden: User "me" cannot list',
  );
});

test("a refused subscribe shows its reason, not that the type is gone", async () => {
  mockBackend({
    ui_state_get: () => null,
    resources_subscribe: () =>
      Promise.reject({
        code: "Unreachable",
        message: "the cluster is not connected",
        details: null,
      }),
  });
  render(screenFor("c1", PODS, [PODS]));
  await act(flush);
  const status = await screen.findByTestId("resource-status");
  expect(status.textContent).toContain("the cluster is not connected");
  expect(status.textContent).not.toMatch(/no longer serves/);
  expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
});

test("bulk delete confirms with the names and count and reports each failure", async () => {
  const deleted: unknown[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      deleted.push(a);
      if (a.name === "ok") return null;
      return Promise.reject({
        code: "Forbidden",
        message: `${a.name} cannot be deleted by you`,
        details: null,
      });
    },
  });
  await show(fake, [pod("ok"), pod("bad1"), pod("bad2"), pod("left")]);
  const bulk = screen.getByTestId("bulk-delete") as HTMLButtonElement;
  expect(bulk.disabled).toBe(true);

  for (const name of ["ok", "bad1", "bad2"]) {
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select default/${name}` }),
    );
  }
  expect(bulk.disabled).toBe(false);
  expect(bulk.textContent).toContain("3");
  fireEvent.click(bulk);

  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Delete 3 Pod objects/)).toBeTruthy();
  for (const name of ["ok", "bad1", "bad2"]) {
    expect(within(dialog).getByText(`default/${name}`)).toBeTruthy();
  }
  expect(within(dialog).queryByText("default/left")).toBeNull();
  expect(deleted).toEqual([]);

  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(deleted).toHaveLength(3);
  expect(deleted).toContainEqual(
    expect.objectContaining({
      name: "ok",
      namespace: "default",
      propagation: "background",
    }),
  );
  const toast = await screen.findByText(/Could not delete 2 of 3 Pod objects/);
  const details = toast.parentElement?.textContent ?? "";
  expect(details).toContain("default/bad1: bad1 cannot be deleted by you");
  expect(details).toContain("default/bad2: bad2 cannot be deleted by you");

  // What failed stays selected, so it can be tried again.
  expect(bulk.textContent).toContain("2");
});

test("a bulk delete with many failures reports each one in a toast that can be read", async () => {
  const names = Array.from({ length: 60 }, (_, i) => `pod-${i}`);
  const fake = fakeBackend({
    resourceDelete: (a) =>
      Promise.reject({
        code: "Forbidden",
        message: `${a.name} cannot be deleted by you`,
        details: null,
      }),
  });
  await show(
    fake,
    names.map((name) => pod(name)),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
  fireEvent.click(screen.getByTestId("bulk-delete"));
  fireEvent.click(screen.getByTestId("delete-confirm"));

  const title = await screen.findByText(
    /Could not delete 60 of 60 Pod objects/,
  );
  const details = title.nextElementSibling as HTMLElement;
  for (const name of names) {
    expect(details.textContent).toContain(
      `default/${name}: ${name} cannot be deleted by you`,
    );
  }
  expect(getComputedStyle(details).overflowY).toBe("auto");
  expect(getComputedStyle(details).maxHeight).not.toBe("none");

  const toast = title.parentElement as HTMLElement;
  fireEvent.click(within(toast).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByText(/of 60 Pod/)).toBeNull());
});

test("a bulk delete only takes the rows still shown", async () => {
  const deleted: string[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      deleted.push(a.name);
      return null;
    },
  });
  await show(fake, [pod("web"), pod("db")]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
  fireEvent.change(screen.getByTestId("resource-search"), {
    target: { value: "web" },
  });
  fireEvent.click(screen.getByTestId("bulk-delete"));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).queryByText("default/db")).toBeNull();
  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(deleted).toEqual(["web"]);
});

test("row delete offers propagation for owners and shows the API error in a toast", async () => {
  const calls: unknown[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      calls.push(a);
      return Promise.reject({
        code: "Forbidden",
        message: "deployments.apps is forbidden",
        details: null,
      });
    },
  });
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);

  openMenu("row-menu-web");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(/Delete Deployment team-a\/web/),
  ).toBeTruthy();
  expect(
    (screen.getByRole("radio", { name: /Background/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /Orphan/ }));

  // Cancelling sends nothing.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls).toEqual([]);

  openMenu("row-menu-web");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("radio", { name: /Foreground/ }));
  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(calls).toEqual([
    expect.objectContaining({
      name: "web",
      namespace: "team-a",
      propagation: "foreground",
      resource: DEPLOYMENTS.resource,
    }),
  ]);
  expect(await screen.findByText("deployments.apps is forbidden")).toBeTruthy();
  expect(
    screen.getByText("Could not delete Deployment team-a/web"),
  ).toBeTruthy();
  // The page stays usable once the menu and the dialog have closed.
  expect(document.body.style.pointerEvents).not.toBe("none");
});

test("a cluster-scoped delete sends no namespace", async () => {
  const calls: { namespace: string | null }[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      calls.push(a);
      return null;
    },
  });
  await show(fake, [{ metadata: { name: "node-1" } }], NODES);
  openMenu("row-menu-node-1");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].namespace).toBeNull();
});

test("delete is disabled when can_delete is false", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("a")], info({}, { canDelete: false }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select default/a" }));
  const bulk = screen.getByTestId("bulk-delete") as HTMLButtonElement;
  expect(bulk.disabled).toBe(true);
  openMenu("row-menu-a");
  expect(
    screen.getByTestId("menu-item-delete").getAttribute("data-disabled"),
  ).not.toBeNull();
});

const WIDGET_CRD: KubeObject = {
  metadata: { name: "widgets.example.com" },
  spec: {
    versions: [
      {
        name: "v1",
        additionalPrinterColumns: [
          { name: "Size", type: "integer", jsonPath: ".spec.size" },
          { name: "Extra", type: "string", jsonPath: ".x", priority: 1 },
        ],
      },
    ],
  },
};

test("a custom resource uses the printer columns of its definition", async () => {
  const fake = fakeBackend();
  const widget = { metadata: { name: "w", namespace: "a" }, spec: { size: 7 } };
  await show(fake, [widget], WIDGETS, "c1", [WIDGETS, CRDS]);
  await fake.send("customresourcedefinitions", {
    type: "snapshot",
    items: [WIDGET_CRD],
  } as WatchEvent);
  expect(screen.getByRole("columnheader", { name: /Size/ })).toBeTruthy();
  expect(screen.getByText("7")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: /Namespace/ })).toBeTruthy();
  // Priority above zero starts hidden and can be turned on.
  expect(screen.queryByRole("columnheader", { name: /Extra/ })).toBeNull();
  openMenu("columns-menu");
  fireEvent.click(screen.getByTestId("column-option-printer-Extra"));
  closeMenu();
  expect(screen.getByRole("columnheader", { name: /Extra/ })).toBeTruthy();
});

test("a custom resource falls back to the defaults when definitions are forbidden", async () => {
  const fake = fakeBackend();
  const widget = { metadata: { name: "w", namespace: "a" }, spec: { size: 7 } };
  await show(fake, [widget], WIDGETS, "c1", [WIDGETS, CRDS]);
  await fake.send("customresourcedefinitions", {
    type: "status",
    status: "forbidden",
    message: "customresourcedefinitions is forbidden",
  });
  expect(screen.getByTestId("resource-table")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: /Age/ })).toBeTruthy();
});

test("definitions are not watched when the user may not list them or the kind is built in", async () => {
  const watched: string[] = [];
  const fake = fakeBackend({ subscribe: (r) => watched.push(r.plural) });
  const hidden = { ...CRDS, canList: false };
  const first = await show(fake, [], WIDGETS, "c1", [WIDGETS, hidden]);
  expect(watched).toEqual(["widgets"]);
  first.unmount();
  resetResourcesForTest();
  watched.length = 0;
  await show(fake, [pod("a")], PODS, "c1", [PODS, CRDS]);
  expect(watched).toEqual(["pods"]);
});

test("a registered kind supplies its columns and row actions", async () => {
  const run = vi.fn();
  registerKind("kinds.test", "gadgets", {
    columns: () => [
      {
        id: "gadget",
        header: "Gadget",
        width: 80,
        render: (o) => `gadget ${o.metadata.name}`,
      },
    ],
    actions: [
      { id: "poke", label: "Poke", icon: Box, run },
      {
        id: "never",
        label: "Never",
        icon: Box,
        visible: () => false,
        run,
      },
      {
        id: "fail",
        label: "Explode",
        icon: Box,
        run: () => Promise.reject(new Error("the gadget exploded")),
      },
    ],
  });
  const gadgets = info({
    group: "kinds.test",
    plural: "gadgets",
    kind: "Gadget",
  });
  const fake = fakeBackend();
  await show(fake, [pod("g")], gadgets);
  expect(screen.getByText("gadget g")).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: /Age/ })).toBeNull();

  openMenu("row-menu-g");
  expect(screen.queryByTestId("menu-item-never")).toBeNull();
  fireEvent.click(screen.getByTestId("menu-item-poke"));
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0].clusterId).toBe("c1");
  expect(run.mock.calls[0][1].metadata.name).toBe("g");

  // An action that fails says so.
  openMenu("row-menu-g");
  fireEvent.click(screen.getByTestId("menu-item-fail"));
  expect(await screen.findByText("the gadget exploded")).toBeTruthy();
});

test("an action can ask for confirmation", async () => {
  const answers: boolean[] = [];
  registerKind("kinds.test", "doodads", {
    actions: [
      {
        id: "ask",
        label: "Ask",
        icon: Box,
        run: async (ctx) => {
          answers.push(
            await ctx.confirm({
              title: "Sure?",
              body: "This does a thing.",
              confirmLabel: "Do it",
            }),
          );
        },
      },
    ],
  });
  const doodads = info({
    group: "kinds.test",
    plural: "doodads",
    kind: "Doodad",
  });
  const fake = fakeBackend();
  await show(fake, [pod("d")], doodads);
  openMenu("row-menu-d");
  fireEvent.click(screen.getByTestId("menu-item-ask"));
  fireEvent.click(await screen.findByRole("button", { name: "Do it" }));
  await waitFor(() => expect(answers).toEqual([true]));
});

function route(context: object, path = "/r/core/pods") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="r/:group/:plural" element={<ResourceRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

test("the route explains a resource the cluster does not serve", async () => {
  mockBackend({});
  render(
    route({
      clusterId: "c1",
      resources: [],
      resourcesLoading: false,
      resourcesError: null,
    }),
  );
  expect(screen.getByTestId("resource-status").textContent).toContain(
    "does not serve",
  );
});

test("the route says when discovery failed and shows loading until it answers", async () => {
  mockBackend({});
  const { rerender } = render(
    route({
      clusterId: "c1",
      resources: [],
      resourcesLoading: true,
      resourcesError: null,
    }),
  );
  expect(screen.getByRole("status", { name: /Loading/ })).toBeTruthy();
  rerender(
    route({
      clusterId: "c1",
      resources: [],
      resourcesLoading: false,
      resourcesError: "discovery broke",
    }),
  );
  const status = screen.getByTestId("resource-status");
  expect(status.textContent).toContain("discovery broke");
  expect(status.textContent).not.toContain("does not serve");
});

test("the route shows the table for a served resource", async () => {
  const fake = fakeBackend();
  render(
    route({
      clusterId: "c1",
      resources: [PODS],
      resourcesLoading: false,
      resourcesError: null,
    }),
  );
  await act(flush);
  await fake.send("pods", {
    type: "snapshot",
    items: [pod("a")],
  } as WatchEvent);
  expect(row("default", "a")).toBeTruthy();
});

test("clicking a row opens its detail drawer through the object param, and Escape closes it", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")]);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  fireEvent.click(row("team-a", "web") as HTMLElement);
  expect(screen.getByTestId("detail-title").textContent).toBe("web");
  expect(row("team-a", "web")?.getAttribute("aria-current")).toBe("true");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
});

/** A press and release of the primary button on `el`, and the click they make. */
function pointerClick(el: Element) {
  fireEvent.pointerDown(el, { button: 0 });
  fireEvent.pointerUp(el, { button: 0 });
  fireEvent.click(el);
}

test("a click on the dimmed list beside the drawer closes it, and focus goes back as with Close", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  // The table's scroller, clear of its rows and header: the empty space under the list.
  pointerClick(
    screen.getByTestId("resource-table").parentElement as HTMLElement,
  );
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(document.activeElement).toBe(row("team-a", "web"));
});

test.each([
  ["the title", () => screen.getByTestId("resource-title")],
  ["a column header", () => screen.getByRole("columnheader", { name: /Age/ })],
  ["Columns", () => screen.getByTestId("columns-menu")],
])(
  "a click on the toolbar or the table's header, as on %s, closes the drawer",
  async (_, target) => {
    const fake = fakeBackend();
    await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
    fireEvent.click(row("team-a", "web") as HTMLElement);
    await act(flush);
    pointerClick(target());
    await act(flush);
    expect(screen.queryByTestId("detail-drawer")).toBeNull();
  },
);

test("a click on the filter box closes the drawer and leaves focus in the box", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  const box = screen.getByTestId("resource-search");
  // The press gives the box focus before the release closes the drawer.
  fireEvent.pointerDown(box, { button: 0 });
  box.focus();
  fireEvent.pointerUp(box, { button: 0 });
  fireEvent.click(box);
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(document.activeElement).toBe(box);
});

test("a click on another row while the drawer is open shows that row in the same drawer", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a"), pod("db", "team-a")], DEPLOYMENTS);
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  const drawer = screen.getByTestId("detail-drawer");
  pointerClick(row("team-a", "db") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-title").textContent).toBe("db");
  // It never closed on the way: the drawer that was open shows the row.
  expect(screen.getByTestId("detail-drawer")).toBe(drawer);
});

test("Edit YAML in a row's menu opens the object in the dock", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")]);

  openMenu("row-menu-web");
  fireEvent.click(screen.getByTestId("menu-item-edit"));

  const { tabs, activeId } = useDock.getState();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({
    kind: "edit",
    clusterId: "c1",
    title: "Pod team-a/web",
    resource: PODS.resource,
    namespace: "team-a",
    name: "web",
  });
  expect(activeId).toBe(tabs[0].id);
  resetDockForTest();
});

test("a row's menu lists Edit YAML, the kind's actions, then Delete, each with an icon", async () => {
  registerKind("kinds.test", "sprockets", {
    actions: [{ id: "spin", label: "Spin", icon: Box, run: () => {} }],
  });
  const sprockets = info({
    group: "kinds.test",
    plural: "sprockets",
    kind: "Sprocket",
  });
  await show(fakeBackend(), [pod("s")], sprockets);
  openMenu("row-menu-s");
  const entries = screen.getAllByRole("menuitem");
  expect(entries.map((e) => e.getAttribute("data-testid"))).toEqual([
    "menu-item-edit",
    "menu-item-spin",
    "menu-item-delete",
  ]);
  for (const entry of entries)
    expect(entry.querySelector("svg")).not.toBeNull();
});

test("the drawer header opens Edit YAML, and its Delete button asks to delete", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
  fireEvent.click(row("team-a", "web") as HTMLElement);

  fireEvent.click(screen.getByTestId("detail-action-edit"));
  expect(useDock.getState().tabs[0]).toMatchObject({
    kind: "edit",
    namespace: "team-a",
    name: "web",
  });
  resetDockForTest();

  // Edit YAML and Delete are both buttons, so there is nothing left for More actions.
  expect(screen.queryByTestId("detail-more-actions")).toBeNull();
  fireEvent.click(screen.getByTestId("detail-action-delete"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(/Delete Deployment team-a\/web/),
  ).toBeTruthy();
  expect(within(dialog).getByTestId("delete-confirm")).toBeTruthy();
});

const GADGET = { group: "example.com", plural: "gadgets", kind: "Gadget" };

test.each([
  [false, true],
  [true, false],
])(
  "an action that needs patch, with canPatch %s, is disabled: %s",
  async (canPatch, disabled) => {
    registerKind("example.com", "gadgets", {
      actions: [
        {
          id: "go",
          label: "Go",
          icon: Box,
          requires: "patch",
          run: () => {},
        },
      ],
    });
    await show(fakeBackend(), [pod("a")], info(GADGET, { canPatch }));
    openMenu("row-menu-a");
    const item = screen.getByTestId("menu-item-go");
    expect(item.getAttribute("data-disabled") !== null).toBe(disabled);
  },
);

test("a cluster-scoped row's checkbox names the object, not a path", async () => {
  await show(fakeBackend(), [{ metadata: { name: "node-1" } }], NODES);
  expect(screen.getByRole("checkbox", { name: "Select node-1" })).toBeTruthy();
});
const opened: string[][] = [];

function OwnDelete(props: DeleteDialogProps) {
  opened.push(props.objects.map((o) => o.metadata.name));
  return (
    <div data-testid="own-delete">
      <button type="button" onClick={props.onCancel}>
        Close own
      </button>
    </div>
  );
}

test("a kind's own delete dialog serves the row menu, the drawer and bulk delete", async () => {
  opened.length = 0;
  registerKind("kinds.test", "deletables", { deleteDialog: OwnDelete });
  const deletables = info({
    group: "kinds.test",
    plural: "deletables",
    kind: "Deletable",
  });
  const fake = fakeBackend();
  await show(fake, [pod("a"), pod("b")], deletables);

  openMenu("row-menu-a");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  expect(screen.getByTestId("own-delete")).toBeTruthy();
  expect(screen.queryByTestId("delete-confirm")).toBeNull();
  expect(opened.at(-1)).toEqual(["a"]);
  fireEvent.click(screen.getByText("Close own"));
  expect(screen.queryByTestId("own-delete")).toBeNull();

  fireEvent.click(row("default", "a") as HTMLElement);
  fireEvent.click(screen.getByTestId("detail-action-delete"));
  expect(screen.getByTestId("own-delete")).toBeTruthy();
  expect(opened.at(-1)).toEqual(["a"]);
  fireEvent.click(screen.getByText("Close own"));

  for (const name of ["a", "b"]) {
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select default/${name}` }),
    );
  }
  fireEvent.click(screen.getByTestId("bulk-delete"));
  expect(screen.getByTestId("own-delete")).toBeTruthy();
  expect(opened.at(-1)).toEqual(["a", "b"]);
});

test("a row click while a linked object is shown clears the history", async () => {
  const fake = fakeBackend();
  const NAMESPACES = info({
    plural: "namespaces",
    kind: "Namespace",
    namespaced: false,
  });
  await show(
    fake,
    [pod("web", "team-a"), pod("db", "team-a")],
    DEPLOYMENTS,
    "c1",
    [DEPLOYMENTS, NAMESPACES],
  );
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  const namespaceLink = () =>
    within(screen.getByTestId("detail-relations")).getByRole("button", {
      name: "team-a",
    });
  fireEvent.click(namespaceLink());
  await act(flush);
  await fake.send("namespaces", {
    type: "snapshot",
    items: [{ metadata: { name: "team-a" } }],
  } as WatchEvent);
  expect(screen.getByTestId("detail-kind").textContent).toBe("Namespace");
  expect(screen.getByTestId("detail-back").getAttribute("aria-label")).toBe(
    "Back to web",
  );
  // No row is active while the drawer shows another kind.
  expect(row("team-a", "web")?.getAttribute("aria-current")).toBeNull();

  fireEvent.click(row("team-a", "db") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-title").textContent).toBe("db");
  expect(screen.queryByTestId("detail-back")).toBeNull();
  expect(row("team-a", "db")?.getAttribute("aria-current")).toBe("true");

  // The root's own row shows the root again.
  fireEvent.click(namespaceLink());
  await act(flush);
  fireEvent.click(row("team-a", "db") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-kind").textContent).toBe("Deployment");
  expect(screen.getByTestId("detail-title").textContent).toBe("db");
  expect(screen.queryByTestId("detail-back")).toBeNull();
});

test("the drawer is a layer over the list that leaves its controls usable but the covered ones", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
  const root = screen.getByTestId("resource-screen");
  expect(screen.getByTestId("bulk-delete").hasAttribute("inert")).toBe(false);
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-drawer").parentElement).toBe(root);
  expect(screen.getByTestId("detail-dim").parentElement).toBe(root);
  expect(screen.getByTestId("bulk-delete").hasAttribute("inert")).toBe(true);
  expect(
    screen.getByTestId("row-menu-web").closest("td")?.hasAttribute("inert"),
  ).toBe(true);
  // The list stays usable under the dim.
  expect(screen.getByTestId("resource-search").hasAttribute("inert")).toBe(
    false,
  );
  fireEvent.click(screen.getByTestId("detail-close"));
  await act(flush);
  expect(screen.getByTestId("bulk-delete").hasAttribute("inert")).toBe(false);
  expect(
    screen.getByTestId("row-menu-web").closest("td")?.hasAttribute("inert"),
  ).toBe(false);
});

test("Escape closes from the drawer and the grid, never from the toolbar, a portal or a textarea", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
  const open = async () => {
    fireEvent.click(row("team-a", "web") as HTMLElement);
    await act(flush);
  };
  await open();
  fireEvent.keyDown(screen.getByTestId("resource-search"), { key: "Escape" });
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
  // A menu sits in a portal: its Escape closes the menu only.
  openMenu("columns-menu");
  closeMenu();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
  const textarea = document.createElement("textarea");
  screen.getByTestId("detail-drawer").append(textarea);
  fireEvent.keyDown(textarea, { key: "Escape" });
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
  textarea.remove();
  fireEvent.keyDown(screen.getByTestId("detail-drawer"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  await open();
  fireEvent.keyDown(row("team-a", "web") as HTMLElement, { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
});

test("closing focuses the root's row when what had focus is gone, else the grid", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
  const temporary = document.createElement("button");
  document.body.append(temporary);
  temporary.focus();
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  temporary.remove();
  fireEvent.click(screen.getByTestId("detail-close"));
  await act(flush);
  expect(document.activeElement).toBe(row("team-a", "web"));

  document.body.append(temporary);
  temporary.focus();
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  temporary.remove();
  // The root's row went away while the drawer was open.
  await fake.send("deployments", {
    type: "snapshot",
    items: [pod("db", "team-a")],
  } as WatchEvent);
  fireEvent.click(screen.getByTestId("detail-close"));
  await act(flush);
  expect(document.activeElement).toBe(screen.getByTestId("resource-table"));
});

/** Shows a screen at `search`, with the router state Open as drawer leaves (spec K14). */
async function showAt(
  fake: Fake,
  search: string,
  state: unknown,
  items: KubeObject[],
  resource: ApiResourceInfo,
) {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/", search, state }]}>
      <ResourceScreen
        key="c1"
        clusterId="c1"
        info={resource}
        resources={[resource]}
      />
    </MemoryRouter>,
  );
  await act(flush);
  await fake.send(resource.resource.plural, {
    type: "snapshot",
    items,
  } as WatchEvent);
  await fake.send(resource.resource.plural, {
    type: "status",
    status: "live",
    message: null,
  });
}

test("a drawer opened with a drawer tab in the router state starts on it; a row click starts on Overview", async () => {
  const fake = fakeBackend();
  await showAt(
    fake,
    "?object=team-a%2Fweb",
    { drawerTab: "events" },
    [pod("web", "team-a"), pod("db", "team-a")],
    DEPLOYMENTS,
  );
  expect(
    screen.getByTestId("detail-tab-events").getAttribute("aria-selected"),
  ).toBe("true");
  expect(document.activeElement).toBe(screen.getByTestId("detail-drawer"));

  fireEvent.click(row("team-a", "db") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-title").textContent).toBe("db");
  expect(
    screen.getByTestId("detail-tab-overview").getAttribute("aria-selected"),
  ).toBe("true");
});

test("a drawer tab the object does not offer starts the drawer on Overview", async () => {
  // Secrets have no map, and their rows are whole, so the drawer shows the row.
  const SECRETS = info({ plural: "secrets", kind: "Secret" });
  await showAt(
    fakeBackend(),
    "?object=team-a%2Fsettings",
    { drawerTab: "map" },
    [pod("settings", "team-a")],
    SECRETS,
  );
  expect(
    screen.getByTestId("detail-tab-overview").getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByTestId("detail-tab-map")).toBeNull();
});

/** Where the router is. */
function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">{`${location.pathname}${location.search}`}</output>
  );
}

/** A screen of the cluster with its dock below, as ClusterLayout shows them. */
async function showWithDock(
  fake: Fake,
  items: KubeObject[],
  resource: ApiResourceInfo,
  resources: ApiResourceInfo[] = [resource],
) {
  const { group, plural } = resource.resource;
  render(
    <MemoryRouter
      initialEntries={[`/cluster/c1/r/${group || "core"}/${plural}`]}
    >
      <ResourceScreen
        key="c1"
        clusterId="c1"
        info={resource}
        resources={resources}
      />
      <Dock clusterId="c1" resources={resources} />
      <Where />
      <Toaster />
    </MemoryRouter>,
  );
  await act(flush);
  await fake.send(plural, { type: "snapshot", items } as WatchEvent);
  await fake.send(plural, { type: "status", status: "live", message: null });
}

test("Open as drawer replaces the open drawer's object, starts on the tab's drawer tab and takes focus", async () => {
  const fake = fakeBackend();
  const db = detailsTab("c1", DEPLOYMENTS.resource, "team-a", "db", "events");
  useDock.getState().open(db);
  await showWithDock(
    fake,
    [pod("web", "team-a"), pod("db", "team-a")],
    DEPLOYMENTS,
  );
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-title").textContent).toBe("web");

  fireEvent.click(
    within(screen.getByTestId(`dock-panel-${db.id}`)).getByTestId(
      "dock-details-pop",
    ),
  );
  await act(flush);
  expect(screen.getByTestId("where").textContent).toBe(
    "/cluster/c1/r/apps/deployments?object=team-a%2Fdb",
  );
  const drawer = screen.getByTestId("detail-drawer");
  expect(screen.getByTestId("detail-title").textContent).toBe("db");
  expect(
    within(drawer)
      .getByTestId("detail-tab-events")
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByTestId("detail-back")).toBeNull();
  expect(document.activeElement).toBe(drawer);
  expect(useDock.getState().tabs).toEqual([]);
});

test("a drawer opened from the dock's strip gives focus back to its row on Close", async () => {
  const fake = fakeBackend();
  const db = detailsTab("c1", DEPLOYMENTS.resource, "team-a", "db", "overview");
  useDock.getState().open(db);
  await showWithDock(
    fake,
    [pod("web", "team-a"), pod("db", "team-a")],
    DEPLOYMENTS,
  );
  fireEvent.click(screen.getByTestId(`dock-pop-${db.id}`));
  await act(flush);
  expect(document.activeElement).toBe(screen.getByTestId("detail-drawer"));

  fireEvent.click(screen.getByTestId("detail-close"));
  await act(flush);
  expect(document.activeElement).toBe(row("team-a", "db"));
});

test("Minimize closes the drawer and shows the object's details tab on the drawer's tab, with focus on its button", async () => {
  const fake = fakeBackend();
  const db = detailsTab("c1", DEPLOYMENTS.resource, "team-a", "db", "overview");
  useDock.getState().open(db);
  useDock.getState().setMinimized(true);
  await showWithDock(
    fake,
    [pod("web", "team-a"), pod("db", "team-a")],
    DEPLOYMENTS,
  );
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  fireEvent.mouseDown(
    within(screen.getByTestId("detail-drawer")).getByTestId(
      "detail-tab-events",
    ),
    { button: 0 },
  );
  await act(flush);

  fireEvent.click(screen.getByTestId("detail-minimize"));
  await act(flush);

  const id = "details:c1:apps/deployments:team-a/web";
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(screen.getByTestId("where").textContent).not.toContain("object=");
  const dock = useDock.getState();
  expect(dock.tabs.map((t) => t.id)).toEqual([db.id, id]);
  expect(dock.tabs[1]).toMatchObject({
    kind: "details",
    title: "Deployment · web",
    tab: "events",
  });
  expect(dock.activeId).toBe(id);
  expect(dock.minimized).toBe(false);
  const shownPanel = screen.getByTestId(`dock-panel-${id}`);
  expect(shownPanel.hidden).toBe(false);
  expect(
    within(shownPanel)
      .getByTestId("detail-tab-events")
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(document.activeElement).toBe(screen.getByTestId(`dock-tab-${id}`));

  // The drawer's history went with it: a row click starts afresh.
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  expect(screen.queryByTestId("detail-back")).toBeNull();
  expect(
    within(screen.getByTestId("detail-drawer"))
      .getByTestId("detail-tab-overview")
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("a second Minimize of the same object opens no second tab, and a row click leaves the tab open", async () => {
  const fake = fakeBackend();
  await showWithDock(fake, [pod("web", "team-a")], DEPLOYMENTS);
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  fireEvent.click(screen.getByTestId("detail-minimize"));
  await act(flush);
  const id = "details:c1:apps/deployments:team-a/web";
  expect(useDock.getState().tabs.map((t) => t.id)).toEqual([id]);
  expect((useDock.getState().tabs[0] as DetailsDockTab).tab).toBe("overview");

  // The same object in the drawer and in the dock (spec K21).
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  expect(useDock.getState().tabs).toHaveLength(1);
  fireEvent.mouseDown(
    within(screen.getByTestId("detail-drawer")).getByTestId(
      "detail-tab-events",
    ),
    { button: 0 },
  );
  await act(flush);

  fireEvent.click(screen.getByTestId("detail-minimize"));
  await act(flush);
  const { tabs, activeId } = useDock.getState();
  expect(tabs.map((t) => t.id)).toEqual([id]);
  expect((tabs[0] as DetailsDockTab).tab).toBe("events");
  expect(activeId).toBe(id);
});

test("Minimize while a linked object is shown docks the linked object", async () => {
  const fake = fakeBackend();
  const NAMESPACES = info({
    plural: "namespaces",
    kind: "Namespace",
    namespaced: false,
  });
  await showWithDock(fake, [pod("web", "team-a")], DEPLOYMENTS, [
    DEPLOYMENTS,
    NAMESPACES,
  ]);
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  fireEvent.click(
    within(screen.getByTestId("detail-relations")).getByRole("button", {
      name: "team-a",
    }),
  );
  await act(flush);
  await fake.send("namespaces", {
    type: "snapshot",
    items: [{ metadata: { name: "team-a" } }],
  } as WatchEvent);
  expect(screen.getByTestId("detail-kind").textContent).toBe("Namespace");

  fireEvent.click(screen.getByTestId("detail-minimize"));
  await act(flush);
  const docked = detailsTab(
    "c1",
    NAMESPACES.resource,
    null,
    "team-a",
    "overview",
  );
  expect(docked.id).toBe("details:c1:/namespaces:/team-a");
  expect(useDock.getState().tabs).toEqual([docked]);
  expect(useDock.getState().activeId).toBe(docked.id);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(
    within(screen.getByTestId(`dock-panel-${docked.id}`)).getByTestId(
      "dock-details-kind",
    ).textContent,
  ).toBe("Namespace");
});

const FILTERABLES = info({
  group: "kinds.test",
  plural: "filterables",
  kind: "Filterable",
});

/** A kind with Status, a hidden IP and Node; `nodeFilter` replaces Node's filter alone, not its cell. */
function registerFilterables(nodeFilter?: ColumnFilter<KubeObject>) {
  const node = textColumn("node", "Node", (o) => o.spec?.nodeName);
  registerKind("kinds.test", "filterables", {
    columns: (i) =>
      baseColumns(
        i.resource,
        statusColumn((o) => ({
          label: o.status?.phase ?? "Unknown",
          tone: "ok",
        })),
        textColumn("ip", "IP", (o) => o.status?.podIP, { defaultHidden: true }),
        nodeFilter ? { ...node, filter: nodeFilter } : node,
      ),
  });
}

function filterable(
  name: string,
  over: { phase?: string; ip?: string; node?: string; ageMs?: number } = {},
): KubeObject {
  return {
    metadata: {
      name,
      namespace: "ns",
      resourceVersion: "1",
      creationTimestamp: new Date(
        Date.now() - (over.ageMs ?? 60_000),
      ).toISOString(),
    },
    spec: { nodeName: over.node },
    status: { phase: over.phase, podIP: over.ip },
  };
}

function typeInBox(text: string) {
  fireEvent.change(screen.getByTestId("resource-search"), {
    target: { value: text },
  });
}

test("free text reads every column, and a match through a hidden one shows a chip", async () => {
  registerFilterables();
  const fake = fakeBackend();
  await show(
    fake,
    [
      filterable("a", { phase: "Running", ip: "10.0.0.5", node: "n1" }),
      filterable("b", { phase: "Pending", ip: "10.0.0.6", node: "n2" }),
    ],
    FILTERABLES,
  );
  typeInBox("10.0.0.5");
  expect(row("ns", "b")).toBeNull();
  expect(chipTitles(row("ns", "a"))).toEqual(["column ip=10.0.0.5"]);

  typeInBox("n2");
  expect(row("ns", "a")).toBeNull();
  expect(chipTitles(row("ns", "b"))).toEqual([]);
});

test("column tokens narrow the rows, and > and < compare times", async () => {
  registerFilterables();
  const fake = fakeBackend();
  await show(
    fake,
    [
      filterable("young", { phase: "Running", ageMs: 30 * 60_000 }),
      filterable("old", { phase: "Pending", ageMs: 3 * 86_400_000 }),
    ],
    FILTERABLES,
  );
  addToken("status = Running");
  expect(row("ns", "young")).toBeTruthy();
  expect(row("ns", "old")).toBeNull();
  expect(
    screen.getByTestId("filter-token-edit-0").getAttribute("aria-label"),
  ).toBe("Edit filter status = Running");

  fireEvent.click(screen.getByTestId("filter-clear"));
  addToken("age > 1d");
  expect(row("ns", "young")).toBeNull();
  expect(row("ns", "old")).toBeTruthy();
});

test("typing reads each row's columns once, not again on every keystroke", async () => {
  // A spy on the filter alone: the cell's own render reads the node too, on every render.
  const nodeText = vi.fn((o: KubeObject) => o.spec?.nodeName ?? null);
  registerFilterables({ text: nodeText });
  const fake = fakeBackend();
  await show(
    fake,
    [filterable("a", { node: "n1" }), filterable("b", { node: "n2" })],
    FILTERABLES,
  );
  typeInBox("n");
  await act(flush);
  const after = nodeText.mock.calls.length;
  typeInBox("n1");
  typeInBox("n1x");
  typeInBox("n1");
  expect(nodeText.mock.calls.length).toBe(after);
  expect(row("ns", "a")).toBeTruthy();
  expect(row("ns", "b")).toBeNull();
});

test("a typed time filter follows the clock: a row leaves age < 1m once it is a minute old", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    registerFilterables();
    const fake = fakeBackend();
    await show(fake, [filterable("fresh", { ageMs: 45_000 })], FILTERABLES);
    typeInBox("age < 1m");
    expect(row("ns", "fresh")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(row("ns", "fresh")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
