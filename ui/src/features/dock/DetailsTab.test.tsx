import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetCatalogForTest } from "../../stores/catalog";
import {
  type DetailsDockTab,
  type DockTab,
  detailsTab,
  resetDockForTest,
  useDock,
} from "../../stores/dock";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { CSS_FILES, type CssRule, cssRules } from "../../test/css";
import { flush, mockBackend } from "../../test/ipc";
import { Dock } from "./Dock";

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

const DEPLOYMENTS = info({
  group: "apps",
  plural: "deployments",
  kind: "Deployment",
});
const NAMESPACES = info({
  plural: "namespaces",
  kind: "Namespace",
  namespaced: false,
});
const CONFIGMAPS = info({ plural: "configmaps", kind: "ConfigMap" });
const WIDGETS = info({
  group: "example.com",
  plural: "widgets",
  kind: "Widget",
});
const GADGETS = info(
  { group: "example.com", plural: "gadgets", kind: "Gadget" },
  { canList: false },
);

const WEB = detailsTab("c1", DEPLOYMENTS.resource, "team-a", "web", "overview");

function kubeObject(name: string, namespace = "team-a"): KubeObject {
  return { metadata: { name, namespace, resourceVersion: "1" } };
}

/** A backend whose watches send what a test gives `rows` and `send`. */
function fakeBackend(over: { get?(args: { name: string }): unknown } = {}) {
  const subs = new Map<string, (event: WatchEvent) => void>();
  mockBackend({
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    resource_get: (a: { name: string }) => {
      if (over.get) return over.get(a);
      throw { code: "NotFound", message: `${a.name} not found` };
    },
    resource_events: () => [],
  });
  async function send(plural: string, event: WatchEvent) {
    await act(async () => {
      subs.get(plural)?.(event);
      await flush();
    });
  }
  return {
    send,
    /** The list's rows, then the watch going live. */
    rows: async (plural: string, items: KubeObject[]) => {
      await send(plural, { type: "snapshot", items } as WatchEvent);
      await send(plural, { type: "status", status: "live", message: null });
    },
  };
}

/** Where the router is, and the state it carries. */
function Where() {
  const location = useLocation();
  return (
    <output
      data-testid="where"
      data-state={JSON.stringify(location.state ?? null)}
    >
      {`${location.pathname}${location.search}`}
    </output>
  );
}

async function showDock(
  resources: ApiResourceInfo[] = [DEPLOYMENTS, NAMESPACES],
) {
  render(
    <MemoryRouter initialEntries={["/cluster/c1/overview"]}>
      <Dock clusterId="c1" resources={resources} />
      <Where />
    </MemoryRouter>,
  );
  await act(flush);
}

const panel = (tab: DockTab) =>
  within(screen.getByTestId(`dock-panel-${tab.id}`));
const stored = () => useDock.getState().tabs[0] as DetailsDockTab;

function where() {
  const output = screen.getByTestId("where");
  return {
    path: output.textContent,
    state: JSON.parse(output.dataset.state ?? "null"),
  };
}

function decl(rules: CssRule[], selector: string, prop: string) {
  return rules
    .find((r) => r.selector === selector)
    ?.decls.find(([p]) => p === prop)?.[1];
}

beforeEach(() => {
  resetDockForTest();
  resetResourcesForTest();
  resetMetricsForTest();
  resetCatalogForTest();
});
afterEach(() => {
  resetDockForTest();
  resetResourcesForTest();
  resetMetricsForTest();
  resetCatalogForTest();
});

test("the tab strip shows the title, then Open as drawer, then Close", async () => {
  fakeBackend();
  useDock.getState().open(WEB);
  await showDock();
  const label = screen.getByTestId(`dock-tab-${WEB.id}`);
  expect(label.textContent).toBe("Deployment · web");
  const pop = screen.getByTestId(`dock-pop-${WEB.id}`);
  expect(pop.getAttribute("aria-label")).toBe(
    "Open Deployment · web as drawer",
  );
  expect(pop.querySelector("svg")?.getAttribute("width")).toBe("12");
  expect(label.nextElementSibling).toBe(pop);
  expect(pop.nextElementSibling).toBe(
    screen.getByTestId(`dock-close-${WEB.id}`),
  );
});

test("the header reads name, kind, actions, a divider and Open as drawer, and the actions wait for the object", async () => {
  const fake = fakeBackend();
  useDock.getState().open(WEB);
  await showDock();
  const p = panel(WEB);
  expect(p.queryByTestId("detail-actions")).toBeNull();

  await fake.rows("deployments", [kubeObject("web")]);
  const title = p.getByTestId("dock-details-title");
  expect(title.tagName).toBe("H3");
  expect(title.textContent).toBe("web");
  expect(title.getAttribute("title")).toBe("team-a/web");
  expect(p.getByTestId("dock-details-kind").textContent).toBe("Deployment");
  expect(p.queryByTestId("dock-details-back")).toBeNull();
  const band = title.parentElement as HTMLElement;
  expect(
    [...band.children].map(
      (el) => el.getAttribute("data-testid") ?? el.getAttribute("aria-hidden"),
    ),
  ).toEqual([
    "dock-details-title",
    "dock-details-kind",
    null,
    "detail-actions",
    "true",
    "dock-details-pop",
  ]);
  const pop = p.getByTestId("dock-details-pop");
  expect(pop.textContent).toBe("Open as drawer");
  expect(pop.querySelector("svg")?.getAttribute("width")).toBe("14");
});

test("a link steps to the linked object within the tab, Back returns, and a tab choice at the root is saved on the tab", async () => {
  const fake = fakeBackend();
  useDock.getState().open(WEB);
  await showDock();
  await fake.rows("deployments", [kubeObject("web")]);
  const p = panel(WEB);

  fireEvent.click(
    within(p.getByTestId("detail-relations")).getByRole("button", {
      name: "team-a",
    }),
  );
  await act(flush);
  await fake.rows("namespaces", [{ metadata: { name: "team-a" } }]);
  expect(p.getByTestId("dock-details-kind").textContent).toBe("Namespace");
  expect(p.getByTestId("dock-details-title").getAttribute("title")).toBe(
    "team-a",
  );
  expect(p.getByTestId("dock-details-back").getAttribute("aria-label")).toBe(
    "Back to web",
  );
  // The tab keeps naming its root (spec K11).
  expect(screen.getByTestId(`dock-tab-${WEB.id}`).textContent).toBe(
    "Deployment · web",
  );
  expect(stored().name).toBe("web");

  fireEvent.click(p.getByTestId("dock-details-back"));
  await act(flush);
  // The root may subscribe again on Back; its rows come back either way.
  await fake.rows("deployments", [kubeObject("web")]);
  expect(p.getByTestId("dock-details-title").textContent).toBe("web");
  expect(p.queryByTestId("dock-details-back")).toBeNull();

  fireEvent.mouseDown(p.getByTestId("detail-tab-events"), { button: 0 });
  await act(flush);
  expect(stored().tab).toBe("events");
  expect(p.getByTestId("detail-tab-events").getAttribute("aria-selected")).toBe(
    "true",
  );
});

test("the band takes the drawer band's look, the body scrolls under it, and the Overview flows into columns", async () => {
  const fake = fakeBackend();
  useDock.getState().open(WEB);
  await showDock();
  await fake.rows("deployments", [kubeObject("web")]);
  const element = screen.getByTestId(`dock-panel-${WEB.id}`);
  const columns = element.querySelector<HTMLElement>(".overviewColumns");
  expect(
    columns?.contains(within(element).getByTestId("detail-relations")),
  ).toBe(true);
  expect(columns?.hidden).toBe(false);
  fireEvent.mouseDown(within(element).getByTestId("detail-tab-events"), {
    button: 0,
  });
  await act(flush);
  expect(columns?.hidden).toBe(true);

  const drawer = cssRules(
    CSS_FILES["/src/features/details/DetailDrawer.module.css"],
  );
  const tab = cssRules(CSS_FILES["/src/features/dock/DetailsTab.module.css"]);
  for (const prop of ["background", "border-bottom"]) {
    expect(decl(tab, ".band", prop)).toBe(decl(drawer, ".band", prop));
  }
  expect(decl(tab, ".title", "font")).toBe("var(--type-heading)");
  expect(decl(tab, ".title", "text-overflow")).toBe("ellipsis");
  expect(decl(tab, ".kind", "font")).toBe("var(--type-label)");
  expect(decl(tab, ".kind", "color")).toBe("var(--text-secondary)");
  expect(decl(tab, ".root", "flex-direction")).toBe("column");
  expect(decl(tab, ".root", "min-height")).toBe("0");
  expect(decl(drawer, ".content", "overflow")).toBe("auto");
  expect(drawer.find((r) => r.selector === ".overviewColumns")?.decls).toEqual([
    ["display", "grid"],
    ["grid-template-columns", "repeat(auto-fill, minmax(360px, 1fr))"],
    ["align-items", "start"],
    ["column-gap", "var(--space-8)"],
  ]);
  expect(
    drawer.find((r) => r.selector === ".overviewColumns[hidden]")?.decls,
  ).toEqual([["display", "none"]]);
});

test("a saved drawer tab the object does not offer shows the Overview and stays saved", async () => {
  const fake = fakeBackend();
  const settings = detailsTab(
    "c1",
    CONFIGMAPS.resource,
    "team-a",
    "settings",
    "map",
  );
  useDock.getState().open(settings);
  await showDock([CONFIGMAPS]);
  await fake.rows("configmaps", [kubeObject("settings")]);
  const p = panel(settings);
  expect(
    p.getByTestId("detail-tab-overview").getAttribute("aria-selected"),
  ).toBe("true");
  expect(p.queryByTestId("detail-tab-map")).toBeNull();
  expect(stored().tab).toBe("map");
});

test("Open as drawer in the panel shows the root over its list on the tab's drawer tab and closes the tab", async () => {
  const fake = fakeBackend();
  const web = detailsTab("c1", DEPLOYMENTS.resource, "team-a", "web", "events");
  useDock.getState().open(web);
  await showDock();
  await fake.rows("deployments", [kubeObject("web")]);
  fireEvent.click(panel(web).getByTestId("dock-details-pop"));
  await act(flush);
  expect(where()).toEqual({
    path: "/cluster/c1/r/apps/deployments?object=team-a%2Fweb",
    state: { drawerTab: "events" },
  });
  expect(useDock.getState().tabs).toEqual([]);
});

test("Open as drawer in the strip opens the linked object the tab shows, on its own list", async () => {
  const fake = fakeBackend();
  useDock.getState().open(WEB);
  await showDock();
  await fake.rows("deployments", [kubeObject("web")]);
  fireEvent.click(
    within(panel(WEB).getByTestId("detail-relations")).getByRole("button", {
      name: "team-a",
    }),
  );
  await act(flush);
  fireEvent.click(screen.getByTestId(`dock-pop-${WEB.id}`));
  await act(flush);
  expect(where()).toEqual({
    path: "/cluster/c1/r/core/namespaces?object=%2Fteam-a",
    state: { drawerTab: "overview" },
  });
  expect(useDock.getState().tabs).toEqual([]);
});

test("a deleted object stays in its tab with no actions, and Open as drawer still works", async () => {
  const fake = fakeBackend();
  useDock.getState().open(WEB);
  await showDock();
  await fake.rows("deployments", [kubeObject("web")]);
  const p = panel(WEB);
  expect(p.getByTestId("detail-actions")).toBeTruthy();

  await fake.send("deployments", {
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "team-a", name: "web" }],
  } as WatchEvent);
  expect(p.getByTestId("detail-removed").textContent).toMatch(/deleted/);
  expect(p.queryByTestId("detail-actions")).toBeNull();
  expect(useDock.getState().tabs).toHaveLength(1);

  fireEvent.click(p.getByTestId("dock-details-pop"));
  await act(flush);
  expect(where().path).toBe(
    "/cluster/c1/r/apps/deployments?object=team-a%2Fweb",
  );
  expect(useDock.getState().tabs).toEqual([]);
});

test("an object read once, as for a kind that cannot be listed, shows its actions and the static note", async () => {
  fakeBackend({ get: () => kubeObject("g1") });
  const gadget = detailsTab("c1", GADGETS.resource, "team-a", "g1", "overview");
  useDock.getState().open(gadget);
  await showDock([GADGETS]);
  await act(flush);
  const p = panel(gadget);
  expect(p.getByTestId("detail-static-note")).toBeTruthy();
  expect(p.getByTestId("detail-actions")).toBeTruthy();
});

test("a tab whose resource is no longer served says so, offers no actions, and Open as drawer goes to its list", async () => {
  const fake = fakeBackend();
  const widget = detailsTab("c1", WIDGETS.resource, "team-a", "w1", "events");
  useDock.getState().open(widget);
  // As after a restart where the CRD is gone: discovery no longer lists it.
  await showDock([DEPLOYMENTS]);
  await fake.send("widgets", {
    type: "status",
    status: "notServed",
    message: "the cluster no longer serves widgets",
  });
  const p = panel(widget);
  expect(p.getByTestId("detail-not-served").textContent).toContain(
    "the cluster no longer serves widgets",
  );
  expect(p.getByTestId("dock-details-kind").textContent).toBe("Widget");
  expect(p.queryByTestId("detail-actions")).toBeNull();

  fireEvent.click(p.getByTestId("dock-details-pop"));
  await act(flush);
  expect(where().path).toBe(
    "/cluster/c1/r/example.com/widgets?object=team-a%2Fw1",
  );
  expect(useDock.getState().tabs).toEqual([]);
});

test("closing a details tab never asks", async () => {
  fakeBackend();
  useDock.getState().open(WEB);
  await showDock();
  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  await act(flush);
  expect(useDock.getState().tabs).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("a details tab shows only in its own cluster's dock", async () => {
  fakeBackend();
  const other = detailsTab(
    "c2",
    DEPLOYMENTS.resource,
    "team-a",
    "web",
    "overview",
  );
  useDock.getState().open(WEB);
  useDock.getState().open(other);
  await showDock();
  expect(screen.getByTestId(`dock-tab-${WEB.id}`)).toBeTruthy();
  expect(screen.queryByTestId(`dock-tab-${other.id}`)).toBeNull();
  expect(screen.queryByTestId(`dock-panel-${other.id}`)).toBeNull();
});
