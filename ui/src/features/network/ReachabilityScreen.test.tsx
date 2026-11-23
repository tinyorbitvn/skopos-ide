import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetReachabilityForTest } from "../../stores/reachability";
import { resetResourcesForTest } from "../../stores/resources";
import { servedResource } from "../../test/graph";
import { flush } from "../../test/ipc";
import {
  IDS,
  paymentsSnapshot,
  type ReachabilityBackend,
  reachabilityBackend,
  rgroup,
  rsnapshot,
} from "../../test/reachability";
import { connectClusters, setClusterState } from "../../test/terminal";
import { ReachabilityScreen } from "./ReachabilityScreen";

const PAGE = "/cluster/c1/network/reachability";
const STORED = "reachability.namespace.c1";
const PAYMENTS = paymentsSnapshot();
const SHOP = rsnapshot("shop", [rgroup("Deployment", "shop", "cart")]);

const SERVED: ApiResourceInfo[] = [
  servedResource("Pod", "", "pods"),
  servedResource("NetworkPolicy", "networking.k8s.io", "networkpolicies"),
  servedResource("CiliumNetworkPolicy", "cilium.io", "ciliumnetworkpolicies"),
  servedResource(
    "CiliumClusterwideNetworkPolicy",
    "cilium.io",
    "ciliumclusterwidenetworkpolicies",
    false,
  ),
];

/** What the drawer reads, answered never, so it stays on its title. */
const DRAWER = {
  resources_subscribe: () => "sub",
  resources_subscribe_object: () => "object-sub",
  resources_unsubscribe: () => null,
  resource_get: () => new Promise(() => {}),
  resource_events: () => new Promise(() => {}),
  ui_state_set: () => null,
};

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

let r: ReachabilityBackend;

/** The page at `path`, with the sidebar's namespace filter `filter` (none when null). */
async function show(
  path = `${PAGE}?ns=payments`,
  options: { filter?: string[] | null; resources?: ApiResourceInfo[] } = {},
) {
  r = reachabilityBackend({
    ...DRAWER,
    ui_state_get: (a: { key: string }) =>
      a.key === "namespaces:c1" ? (options.filter ?? null) : null,
  });
  const context = {
    clusterId: "c1",
    resources: options.resources ?? SERVED,
    resourcesLoading: false,
    resourcesError: null,
  };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route
            path="cluster/:id/network/reachability"
            element={<ReachabilityScreen />}
          />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );
  await act(flush);
}

async function showPayments() {
  await show();
  await r.send(PAYMENTS);
}

const where = () => screen.getByTestId("where").textContent;
const text = (id: string) => screen.getByTestId(id).textContent;
const subscribed = () =>
  r.backend
    .callsTo("network_reachability_subscribe")
    .map((c) => [c.clusterId, c.namespace]);
const rowIds = () =>
  [
    ...screen
      .getByTestId("reach-matrix")
      .querySelectorAll("[data-testid^='reach-row-']"),
  ].map((e) => e.getAttribute("data-testid"));

beforeEach(() => {
  resetReachabilityForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  localStorage.clear();
  connectClusters({ id: "c1", name: "c1" });
  setClusterState("c1", {
    status: "connected",
    info: {
      version: "v1.33.1",
      distribution: "kind",
      nodeCount: 2,
      namespaces: ["default", "payments", "shop"],
      namespacesRestricted: false,
      isAdmin: true,
    },
  });
});
afterEach(() => {
  resetReachabilityForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  localStorage.clear();
});

test("the bar names the page, the namespace, each source's policies and the filter", async () => {
  await showPayments();
  expect(subscribed()).toEqual([["c1", "payments"]]);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "Reachability",
  );
  expect(
    screen.getByText(
      "From the NetworkPolicies and Cilium policies that select Pods in this namespace. What the network plugin enforces may differ.",
    ),
  ).toBeTruthy();
  const select = screen.getByRole("combobox", { name: "Namespace" });
  expect(select).toBe(screen.getByTestId("reach-namespace"));
  expect(select.textContent).toBe("payments");
  expect([text("reach-count-kubernetes"), text("reach-count-cilium")]).toEqual([
    "K8s 6 policies",
    "Cilium 4 policies",
  ]);
  expect(
    screen.getByRole("searchbox", { name: "Filter workloads" }),
  ).toHaveProperty("placeholder", "Filter workloads");
});

test("the not-evaluated chip lists policy: field lines in its tooltip", async () => {
  await showPayments();
  const chip = screen.getByTestId("reach-not-evaluated");
  expect(chip.textContent).toBe("1 rule not evaluated");
  fireEvent.focus(chip);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "api-egress-stripe: rules.dns",
  );
});

test("without Cilium only the K8s chip shows, and one policy is singular", async () => {
  await show();
  await r.send(
    rsnapshot("payments", [rgroup("Deployment", "payments", "api")], {
      counts: { kubernetes: 1, cilium: 0 },
    }),
  );
  expect(text("reach-count-kubernetes")).toBe("K8s 1 policy");
  expect(screen.queryByTestId("reach-count-cilium")).toBeNull();
  expect(screen.queryByTestId("reach-not-evaluated")).toBeNull();
});

test("until the first snapshot the matrix area shows the spinner", async () => {
  await show();
  expect(text("reach-loading")).toBe("Loading reachability…");
  expect(
    screen.getByRole("status", { name: "Loading reachability…" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("reach-matrix")).toBeNull();
});

test("a namespace without Pods says so, with the namespace select still there", async () => {
  await show();
  await r.send(rsnapshot("payments"));
  expect(text("reach-empty")).toBe("No Pods in payments");
  expect(screen.getByTestId("reach-namespace")).toBeTruthy();
  expect(screen.queryByTestId("reach-matrix")).toBeNull();
});

test("a failure shows the core's message, and Retry subscribes again", async () => {
  await show();
  await r.send({
    type: "failure",
    message: "Pods cannot be listed: pods is forbidden",
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Pods cannot be listed: pods is forbidden",
  );
  expect(screen.queryByTestId("reach-loading")).toBeNull();
  fireEvent.click(screen.getByTestId("reach-retry"));
  await act(flush);
  expect(subscribed()).toEqual([
    ["c1", "payments"],
    ["c1", "payments"],
  ]);
  expect(screen.queryByTestId("reach-error")).toBeNull();
  expect(screen.getByTestId("reach-loading")).toBeTruthy();
  await r.send(PAYMENTS);
  expect(screen.getByTestId("reach-matrix")).toBeTruthy();
});

test("the banner names a kind that cannot be listed", async () => {
  await show();
  await r.send({
    ...PAYMENTS,
    missing: [
      { plural: "ciliumnetworkpolicies", reason: "listing is forbidden" },
    ],
  });
  expect(text("reach-banner")).toBe(
    "CiliumNetworkPolicies cannot be listed: listing is forbidden. Connections may be wrong.",
  );
  // The rest of the page still shows.
  expect(text(`reach-cell-${IDS.web}--${IDS.api}`)).toBe("8080 GET /api/.*");
  expect(screen.getByTestId("reach-panel")).toBeTruthy();
});

test("no banner shows while every kind can be listed", async () => {
  await showPayments();
  expect(screen.queryByTestId("reach-banner")).toBeNull();
});

interface Start {
  name: string;
  path: string;
  filter: string[] | null;
  stored: string | null;
  expected: string;
}

const STARTS: Start[] = [
  {
    name: "ns when present",
    path: `${PAGE}?ns=payments`,
    filter: ["shop"],
    stored: "kube-system",
    expected: "payments",
  },
  {
    name: "the sidebar filter's first namespace",
    path: PAGE,
    filter: ["shop", "payments"],
    stored: "kube-system",
    expected: "shop",
  },
  {
    name: "the last pick on this cluster",
    path: PAGE,
    filter: [],
    stored: "kube-system",
    expected: "kube-system",
  },
  {
    name: "default",
    path: PAGE,
    filter: null,
    stored: null,
    expected: "default",
  },
];

test.each(STARTS)(
  "the namespace starts on $name (R8)",
  async ({ path, filter, stored, expected }) => {
    if (stored !== null) localStorage.setItem(STORED, stored);
    await show(path, { filter });
    expect(subscribed()).toEqual([["c1", expected]]);
    expect(where()).toBe(`${PAGE}?ns=${expected}`);
    expect(text("reach-namespace")).toBe(expected);
  },
);

test("picking another namespace shows only its snapshot", async () => {
  await showPayments();
  expect(rowIds()).toContain(`reach-row-${IDS.api}`);
  r.hold();
  fireEvent.keyDown(screen.getByTestId("reach-namespace"), { key: "Enter" });
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["default", "payments", "shop"]);
  fireEvent.click(await screen.findByRole("option", { name: "shop" }));
  await act(flush);
  expect(where()).toBe(`${PAGE}?ns=shop`);
  expect(localStorage.getItem(STORED)).toBe("shop");
  expect(subscribed()).toEqual([
    ["c1", "payments"],
    ["c1", "shop"],
  ]);
  expect(screen.queryByTestId("reach-matrix")).toBeNull();
  expect(screen.getByTestId("reach-loading")).toBeTruthy();

  // The namespace left behind still sends: the page does not show it.
  await r.send(PAYMENTS, "r1");
  expect(screen.queryByTestId("reach-matrix")).toBeNull();
  expect(screen.queryByTestId("reach-count-cilium")).toBeNull();

  await r.answer();
  await r.send(SHOP, "r2");
  expect(rowIds()).toEqual([
    "reach-row-Deployment/shop/cart",
    "reach-row-otherPods",
    "reach-row-world",
  ]);
  expect(text("reach-count-kubernetes")).toBe("K8s 0 policies");
  await r.send(PAYMENTS, "r1");
  expect(rowIds()).not.toContain(`reach-row-${IDS.api}`);
});

test("the panel shows the first workload until a row is selected, and a second click clears it", async () => {
  await showPayments();
  const panelName = () =>
    within(screen.getByTestId("reach-panel")).getByRole("heading", {
      level: 3,
    }).textContent;
  expect(panelName()).toBe("api");
  expect(
    screen
      .getByTestId("reach-matrix")
      .querySelectorAll("[aria-pressed='true']"),
  ).toHaveLength(0);
  const web = screen.getByTestId(`reach-row-${IDS.web}`);
  fireEvent.click(web);
  expect(panelName()).toBe("web");
  expect(web.getAttribute("aria-pressed")).toBe("true");
  expect(
    screen
      .getByTestId(`reach-cell-${IDS.api}--${IDS.db}`)
      .hasAttribute("data-dim"),
  ).toBe(true);
  fireEvent.click(web);
  expect(panelName()).toBe("api");
  expect(web.getAttribute("aria-pressed")).toBe("false");
});

test("a policy chip opens the policy in the drawer, and Escape closes it", async () => {
  await showPayments();
  fireEvent.click(
    screen.getByTestId("reach-policy-kubernetes-payments-allow-web-to-api"),
  );
  expect(where()).toBe(
    `${PAGE}?ns=payments&open=networkpolicies.networking.k8s.io&object=payments%2Fallow-web-to-api`,
  );
  await act(flush);
  expect(text("detail-title")).toBe("allow-web-to-api");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(where()).toBe(`${PAGE}?ns=payments`);

  fireEvent.click(
    screen.getByTestId(
      "reach-policy-ciliumClusterwide--allow-prometheus-scrape",
    ),
  );
  expect(where()).toBe(
    `${PAGE}?ns=payments&open=ciliumclusterwidenetworkpolicies.cilium.io&object=%2Fallow-prometheus-scrape`,
  );
  await act(flush);
  expect(text("detail-title")).toBe("allow-prometheus-scrape");
});

test("a chip of a kind the cluster does not serve is no button", async () => {
  await show(`${PAGE}?ns=payments`, { resources: SERVED.slice(0, 2) });
  await r.send(PAYMENTS);
  expect(
    screen.getByTestId("reach-policy-kubernetes-payments-allow-web-to-api")
      .tagName,
  ).toBe("BUTTON");
  expect(
    screen.getByTestId("reach-policy-cilium-payments-allow-api-from-web")
      .tagName,
  ).toBe("SPAN");
});

test("the filter keeps workloads and peers by name or label, case-insensitive", async () => {
  await showPayments();
  const filter = screen.getByTestId("reach-filter");
  fireEvent.change(filter, { target: { value: "API" } });
  expect(rowIds()).toEqual([`reach-row-${IDS.api}`]);
  expect(
    [
      ...screen
        .getByTestId("reach-matrix")
        .querySelectorAll("[data-testid^='reach-col-']"),
    ].map((e) => e.getAttribute("data-testid")),
  ).toEqual([`reach-col-${IDS.api}`, `reach-col-${IDS.stripe}`]);
  fireEvent.change(filter, { target: { value: "tier=frontend" } });
  expect(rowIds()).toEqual([`reach-row-${IDS.web}`]);
  fireEvent.change(filter, { target: { value: "" } });
  expect(rowIds()).toHaveLength(8);
});

test("past 100 workloads the matrix draws 100 and says how many there are", async () => {
  await show(`${PAGE}?ns=big`);
  const groups = Array.from({ length: 150 }, (_, i) =>
    rgroup("Deployment", "big", `app-${String(i).padStart(3, "0")}`),
  );
  await r.send(rsnapshot("big", groups));
  expect(text("reach-cap")).toBe(
    "Showing 100 of 150 workloads. Filter to see the rest.",
  );
  expect(
    screen.getByTestId("reach-matrix").querySelectorAll("button[aria-pressed]"),
  ).toHaveLength(100);
  fireEvent.change(screen.getByTestId("reach-filter"), {
    target: { value: "app-14" },
  });
  expect(screen.queryByTestId("reach-cap")).toBeNull();
});
