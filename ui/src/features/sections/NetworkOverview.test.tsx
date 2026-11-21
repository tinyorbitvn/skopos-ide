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
import { CSS_FILES } from "../../test/css";
import { servedResource } from "../../test/graph";
import { flush, mockBackend } from "../../test/ipc";
import { metricsServer, usageSnapshot } from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import type { ClusterOutletContext } from "../cluster/ClusterLayout";
import { NetworkOverview } from "./NetworkOverview";
import { GATEWAY_GROUP } from "./networkModel";

const RESOURCES: ApiResourceInfo[] = [
  servedResource("Service", "", "services"),
  servedResource("EndpointSlice", "discovery.k8s.io", "endpointslices"),
  servedResource("Ingress", "networking.k8s.io", "ingresses"),
  servedResource("NetworkPolicy", "networking.k8s.io", "networkpolicies"),
  servedResource("Gateway", GATEWAY_GROUP, "gateways"),
  servedResource("HTTPRoute", GATEWAY_GROUP, "httproutes"),
  servedResource("GRPCRoute", GATEWAY_GROUP, "grpcroutes"),
  servedResource("TLSRoute", GATEWAY_GROUP, "tlsroutes"),
  servedResource("TCPRoute", GATEWAY_GROUP, "tcproutes"),
  servedResource("UDPRoute", GATEWAY_GROUP, "udproutes"),
];
/** A cluster without the Gateway API: its CRDs are not installed. */
const CORE = RESOURCES.slice(0, 4);

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

function slice(
  name: string,
  service: string,
  endpoints: (boolean | null)[],
): KubeObject {
  return {
    metadata: {
      name,
      namespace: "shop",
      uid: `endpointslices/shop/${name}`,
      resourceVersion: "1",
      labels: { "kubernetes.io/service-name": service },
    },
    endpoints: endpoints.map((r) =>
      r === null ? {} : { conditions: { ready: r } },
    ),
  } as KubeObject;
}

/** Two ClusterIP (one headless), two LoadBalancer (one Pending) and one ExternalName. */
const SERVICES = [
  obj("services", "shop", "web", {
    spec: {
      type: "ClusterIP",
      clusterIP: "10.96.0.10",
      ports: [{ port: 80, protocol: "TCP" }],
    },
  }),
  obj("services", "shop", "db", {
    spec: { type: "ClusterIP", clusterIP: "None", ports: [{ port: 5432 }] },
  }),
  obj("services", "shop", "edge", {
    spec: {
      type: "LoadBalancer",
      ports: [{ port: 443, nodePort: 30443, protocol: "TCP" }],
    },
    status: {
      loadBalancer: {
        ingress: [{ ip: "203.0.113.7" }, { hostname: "lb.example.com" }],
      },
    },
  }),
  obj("services", "shop", "idle", {
    spec: { type: "LoadBalancer", ports: [{ port: 80, nodePort: 30080 }] },
    status: { loadBalancer: {} },
  }),
  obj("services", "shop", "ext", {
    spec: { type: "ExternalName", externalName: "db.example.com" },
  }),
];
/** 5 endpoints, 2 ready: web has none ready of 3, idle has no slice. */
const SLICES = [
  slice("web-abc", "web", [false, false, false]),
  slice("db-abc", "db", [true]),
  slice("edge-abc", "edge", [null]),
];
const INGRESSES = [
  obj("ingresses", "shop", "web", {
    spec: {
      rules: [
        {
          host: "shop.example.com",
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name: "web", port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  }),
  obj("ingresses", "shop", "api", {
    spec: {
      rules: [
        {
          host: "api.example.com",
          http: {
            paths: [
              {
                path: "/v1",
                pathType: "Prefix",
                backend: { service: { name: "api", port: { name: "http" } } },
              },
            ],
          },
        },
      ],
    },
    status: { loadBalancer: { ingress: [{ ip: "198.51.100.4" }] } },
  }),
];
const GATEWAYS = [
  obj("gateways", "shop", "public", {
    status: { conditions: [{ type: "Programmed", status: "True" }] },
  }),
  obj("gateways", "shop", "staging", {
    status: { conditions: [{ type: "Programmed", status: "False" }] },
  }),
];
const HTTP_ROUTES = [
  obj("httproutes", "shop", "store", {
    spec: {
      hostnames: ["store.example.com"],
      rules: [
        {
          matches: [{ path: { type: "PathPrefix", value: "/cart" } }],
          backendRefs: [{ name: "cart", port: 8080 }],
        },
      ],
    },
  }),
];
const POLICIES = [
  obj("networkpolicies", "shop", "deny-all"),
  obj("networkpolicies", "shop", "allow-web"),
  obj("networkpolicies", "payments", "deny-all"),
];

function fake(uiState: Record<string, unknown> = {}) {
  const subs = new Map<string, (e: WatchEvent) => void>();
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) => uiState[a.key] ?? null,
    ui_state_set: () => null,
    metrics_provider: () => metricsServer(),
    metrics_usage: () => usageSnapshot([]),
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
  });
  const list = async (plural: string, items: KubeObject[]) => {
    await act(async () => {
      subs.get(plural)?.({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  };
  /** Every list of the page, filled from the fixtures. */
  const listAll = async () => {
    await list("services", SERVICES);
    await list("endpointslices", SLICES);
    await list("ingresses", INGRESSES);
    await list("networkpolicies", POLICIES);
    await list("gateways", GATEWAYS);
    await list("httproutes", HTTP_ROUTES);
    for (const plural of [
      "grpcroutes",
      "tlsroutes",
      "tcproutes",
      "udproutes",
    ]) {
      await list(plural, []);
    }
  };
  /** The plurals subscribed to, each once, sorted. */
  const subscribed = () =>
    [
      ...new Set(
        backend
          .callsTo("resources_subscribe")
          .map((a) => (a.resource as ResourceRef).plural),
      ),
    ].sort();
  /** What each subscription named, sorted by plural: the plural and the namespaces. */
  const asked = () =>
    backend
      .callsTo("resources_subscribe")
      .map((a): [string, unknown] => [
        (a.resource as ResourceRef).plural,
        a.namespaces,
      ])
      .sort(([a], [b]) => a.localeCompare(b));
  return { backend, list, listAll, subscribed, asked };
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
  render(
    <MemoryRouter initialEntries={["/cluster/c1/network"]}>
      <Routes>
        <Route path="/cluster/:id" element={<Outlet context={context} />}>
          <Route
            path="network"
            element={
              <>
                <NetworkOverview />
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
  return f;
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

beforeEach(() => {
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("the page lays out Summary, then Endpoints ready and Ingresses and routes, then Load balancers", async () => {
  await show();
  expect(text("network-overview-title")).toBe("Network overview");
  expect(screen.queryByTestId("network-overview-namespaces")).toBeNull();
  const cells = [
    ...screen.getByTestId("network-overview").querySelectorAll("[data-span]"),
  ];
  expect(
    cells.map((c) => [
      c.getAttribute("data-span"),
      c.firstElementChild?.getAttribute("data-testid"),
    ]),
  ).toEqual([
    ["12", "network-overview-card-summary"],
    ["5", "network-overview-card-endpoints"],
    ["7", "network-overview-card-routes"],
    ["12", "network-overview-card-load-balancers"],
  ]);
  for (const name of [
    "Summary",
    "Endpoints ready",
    "Ingresses and routes",
    "Load balancers",
  ]) {
    expect(screen.getByRole("region", { name })).toBeTruthy();
  }
});

test("the Summary's seven tiles sit four then three", async () => {
  await show();
  const row = screen
    .getByTestId("overview-tile-cluster-ip")
    .closest("[data-n]");
  expect(row?.getAttribute("data-n")).toBe("7");
  expect(row?.closest(".networkSummary")).toBe(
    screen
      .getByTestId("network-overview-card-summary")
      .querySelector(".networkSummary"),
  );
  const css = CSS_FILES["/src/features/sections/Sections.module.css"] ?? "";
  expect(css.replace(/\s+/g, " ")).toContain(
    '@container tiles (min-width: 716px) { .networkSummary div[data-n="7"] { --cols: 4; } }',
  );
});

test("the namespaces chosen in the lists show as a note, and every list is asked for them", async () => {
  const f = fake({ "namespaces:c1": ["shop"] });
  await show(f);
  expect(text("network-overview-namespaces")).toBe("Namespaces: shop");
  expect(f.asked()).toEqual(
    [
      "endpointslices",
      "gateways",
      "grpcroutes",
      "httproutes",
      "ingresses",
      "networkpolicies",
      "services",
      "tcproutes",
      "tlsroutes",
      "udproutes",
    ].map((plural) => [plural, ["shop"]]),
  );
});

test("Summary counts the Services by type, the Ingresses, the Gateways and their routes, and the NetworkPolicies, each tile opening its list", async () => {
  const f = fake();
  await show(f);
  expect(text("overview-tile-cluster-ip-sub")).toBe("Loading");
  await f.listAll();
  const read = (id: string) => [
    text(`overview-tile-${id}-number`),
    text(`overview-tile-${id}-sub`),
    tone(`overview-tile-${id}`),
  ];
  expect(read("cluster-ip")).toEqual(["2", "1 headless", "neutral"]);
  expect(read("node-port")).toEqual(["0", "None", "neutral"]);
  expect(read("load-balancer")).toEqual(["2", "1 Pending", "warn"]);
  expect(read("external-name")).toEqual([
    "1",
    "Names outside the cluster",
    "neutral",
  ]);
  expect(read("ingresses")).toEqual(["2", "1 without an address", "warn"]);
  expect(read("gateways")).toEqual(["2", "1 route · 1 not Programmed", "warn"]);
  expect(read("policies")).toEqual(["3", "In 2 namespaces", "neutral"]);
  expect(
    [
      "cluster-ip",
      "node-port",
      "load-balancer",
      "external-name",
      "ingresses",
      "gateways",
      "policies",
    ].map((id) => href(`overview-tile-${id}`)),
  ).toEqual([
    "/cluster/c1/r/core/services",
    "/cluster/c1/r/core/services",
    "/cluster/c1/r/core/services",
    "/cluster/c1/r/core/services",
    "/cluster/c1/r/networking.k8s.io/ingresses",
    "/cluster/c1/r/gateway.networking.k8s.io/gateways",
    "/cluster/c1/r/networking.k8s.io/networkpolicies",
  ]);
});

test("without the Gateway API the Gateways tile says so and Ingresses still list", async () => {
  const f = fake();
  await show(f, CORE);
  const gateways = screen.getByTestId(
    "overview-tile-gateways",
  ) as HTMLButtonElement;
  expect(gateways.disabled).toBe(true);
  expect(text("overview-tile-gateways-number")).toBe("—");
  expect(text("overview-tile-gateways-sub")).toBe(
    "Gateway API is not installed",
  );
  expect(tone("overview-tile-gateways")).toBe("neutral");
  await f.list("ingresses", INGRESSES);
  expect(rowIds("network-routes")).toEqual([
    "network-routes-row-Ingress/shop/api/api.example.com",
    "network-routes-row-Ingress/shop/web/shop.example.com",
  ]);
  expect(f.subscribed()).toEqual([
    "endpointslices",
    "ingresses",
    "networkpolicies",
    "services",
  ]);
});

test("Endpoints ready draws ready of all endpoints, lists the Services without one, and a row opens the Service's drawer", async () => {
  const f = fake();
  await show(f);
  expect(text("network-dark-services-loading")).toBe("Loading");
  await f.list("services", SERVICES);
  await f.list("endpointslices", SLICES);
  expect(text("overview-capacity-endpoints-values")).toBe("2 / 5");
  expect(text("overview-capacity-endpoints-note")).toBe("3 EndpointSlices");
  expect(
    within(screen.getByTestId("overview-capacity-endpoints"))
      .getByRole("img")
      .getAttribute("aria-label"),
  ).toBe("Ready endpoints 40%, 2 of 5");
  expect(text("network-overview-card-endpoints")).toContain(
    "Services without ready endpoints",
  );
  expect(rowIds("network-dark-services")).toEqual([
    "network-dark-services-row-shop/idle",
    "network-dark-services-row-shop/web",
  ]);
  const idle = text("network-dark-services-row-shop/idle");
  expect(idle).toContain("LoadBalancer");
  expect(idle).toContain("None");
  const web = text("network-dark-services-row-shop/web");
  expect(web).toContain("ClusterIP");
  expect(web).toContain("0 of 3");

  fireEvent.click(screen.getByTestId("network-dark-services-open-shop/web"));
  expect(text("where")).toBe(
    "/cluster/c1/network?open=services&object=shop%2Fweb",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("Service");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe("/cluster/c1/network");
});

test("Ingresses and routes lists a row per host, Ingresses first, and a row opens its Ingress or route", async () => {
  const f = fake();
  await show(f);
  await f.listAll();
  expect(rowIds("network-routes")).toEqual([
    "network-routes-row-Ingress/shop/api/api.example.com",
    "network-routes-row-Ingress/shop/web/shop.example.com",
    "network-routes-row-HTTPRoute/shop/store/store.example.com",
  ]);
  const api = text("network-routes-row-Ingress/shop/api/api.example.com");
  expect(api).toContain("api.example.com");
  expect(api).toContain("Ingress shop/api");
  expect(api).toContain("/v1");
  expect(api).toContain("api:http");
  const store = text(
    "network-routes-row-HTTPRoute/shop/store/store.example.com",
  );
  expect(store).toContain("HTTPRoute shop/store");
  expect(store).toContain("/cart");
  expect(store).toContain("cart:8080");

  fireEvent.click(
    screen.getByTestId("network-routes-open-Ingress/shop/web/shop.example.com"),
  );
  expect(text("where")).toBe(
    "/cluster/c1/network?open=ingresses.networking.k8s.io&object=shop%2Fweb",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("Ingress");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();

  fireEvent.click(
    screen.getByTestId(
      "network-routes-open-HTTPRoute/shop/store/store.example.com",
    ),
  );
  expect(text("where")).toBe(
    "/cluster/c1/network?open=httproutes.gateway.networking.k8s.io&object=shop%2Fstore",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("HTTPRoute");
});

test("Load balancers list the LoadBalancer Services with their addresses and ports, and a row opens the Service", async () => {
  const f = fake();
  await show(f);
  expect(text("network-load-balancers-loading")).toBe("Loading");
  await f.list("services", SERVICES);
  expect(rowIds("network-load-balancers")).toEqual([
    "network-load-balancers-row-shop/edge",
    "network-load-balancers-row-shop/idle",
  ]);
  const edge = text("network-load-balancers-row-shop/edge");
  expect(edge).toContain("203.0.113.7, lb.example.com");
  expect(edge).toContain("443:30443/TCP");
  const idle = screen.getByTestId("network-load-balancers-row-shop/idle");
  expect(within(idle).getByText("Pending")).toBeTruthy();
  expect(idle.textContent).toContain("80:30080/TCP");

  fireEvent.click(screen.getByTestId("network-load-balancers-open-shop/edge"));
  expect(text("where")).toBe(
    "/cluster/c1/network?open=services&object=shop%2Fedge",
  );
});

test("a kind the account may not list disables its tile and says so in its card", async () => {
  const resources = RESOURCES.map((r) =>
    r.resource.plural === "endpointslices" ||
    r.resource.plural === "networkpolicies"
      ? { ...r, canList: false }
      : r,
  );
  const f = fake();
  await show(f, resources);
  await f.list("services", SERVICES);
  const policies = screen.getByTestId(
    "overview-tile-policies",
  ) as HTMLButtonElement;
  expect(policies.disabled).toBe(true);
  expect(text("overview-tile-policies-sub")).toBe(
    "You may not list NetworkPolicies",
  );
  expect(
    heading("network-dark-services-empty", "You may not list EndpointSlices"),
  ).toBeTruthy();
  expect(text("overview-capacity-endpoints-values")).toBe("No data");
});

test("with every list empty each card shows its empty state", async () => {
  const f = fake();
  await show(f);
  expect(text("network-routes-loading")).toBe("Loading");
  expect(text("overview-tile-gateways-sub")).toBe("Loading");
  for (const plural of [
    "services",
    "endpointslices",
    "ingresses",
    "networkpolicies",
    "gateways",
    "httproutes",
    "grpcroutes",
    "tlsroutes",
    "tcproutes",
    "udproutes",
  ]) {
    await f.list(plural, []);
  }
  expect(
    heading(
      "network-dark-services-empty",
      "Every Service has a ready endpoint",
    ),
  ).toBeTruthy();
  expect(
    heading("network-routes-empty", "No Ingresses or routes"),
  ).toBeTruthy();
  expect(text("network-routes-empty")).toContain(
    "Ingresses and HTTPRoutes, GRPCRoutes and TLSRoutes with hostnames show here.",
  );
  expect(
    heading("network-load-balancers-empty", "No LoadBalancer Services"),
  ).toBeTruthy();
  expect(text("network-load-balancers-empty")).toContain(
    "A Service of type LoadBalancer gets its external address from the cloud provider.",
  );
  expect(text("overview-tile-cluster-ip-sub")).toBe("None");
  expect(text("overview-tile-gateways-sub")).toBe("0 routes");
  expect(text("overview-tile-policies-sub")).toBe(
    "None, so all traffic is allowed",
  );
  expect(text("overview-capacity-endpoints-values")).toBe("No data");
  expect(text("overview-capacity-endpoints-note")).toBe("0 EndpointSlices");
});
