import { expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import type { ListView } from "../workloads/counts";
import {
  addressCell,
  balancersEmpty,
  darkEmpty,
  endpointsReady,
  hostRowKeys,
  hostRows,
  loadBalancerRows,
  networkTiles,
  routesEmpty,
} from "./networkModel";
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

const obj = (
  namespace: string,
  name: string,
  rest: Record<string, unknown> = {},
): KubeObject => ({ metadata: { name, namespace }, ...rest });
const key = (o: KubeObject) => `${o.metadata.namespace}/${o.metadata.name}`;

/** A Service; `ingress` is its `status.loadBalancer.ingress`. */
const service = (
  namespace: string,
  name: string,
  spec: Record<string, unknown>,
  ingress?: Record<string, string>[],
): KubeObject =>
  obj(namespace, name, {
    spec,
    status: ingress === undefined ? {} : { loadBalancer: { ingress } },
  });

/** An EndpointSlice of `owner`'s, with one endpoint per entry: its `conditions.ready`, or none. */
const slice = (
  namespace: string,
  owner: string | null,
  endpoints: (boolean | null)[],
): KubeObject => ({
  metadata: {
    name: `${owner ?? "orphan"}-${endpoints.length}`,
    namespace,
    labels: owner === null ? {} : { "kubernetes.io/service-name": owner },
  },
  endpoints: endpoints.map((r) =>
    r === null ? {} : { conditions: { ready: r } },
  ),
});

const ingress = (
  namespace: string,
  name: string,
  rules: unknown[],
  spec: Record<string, unknown> = {},
  address?: string,
): KubeObject =>
  obj(namespace, name, {
    spec: { rules, ...spec },
    status:
      address === undefined
        ? {}
        : { loadBalancer: { ingress: [{ ip: address }] } },
  });

const backend = (name: string, port: Record<string, unknown>) => ({
  service: { name, port },
});

const route = (
  namespace: string,
  name: string,
  hostnames: string[],
  rules: unknown[],
): KubeObject => obj(namespace, name, { spec: { hostnames, rules } });

const gateway = (name: string, programmed: string | null): KubeObject =>
  obj("shop", name, {
    status: {
      conditions:
        programmed === null ? [] : [{ type: "Programmed", status: programmed }],
    },
  });

function tiles(over: Partial<Parameters<typeof networkTiles>[0]> = {}) {
  return networkTiles({
    clusterId: "c1",
    services: ready([]),
    ingresses: ready([]),
    gateways: ready([]),
    routes: [ready([]), ready([]), ready([]), ready([]), ready([])],
    policies: ready([]),
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

const SERVICES_LIST = "/cluster/c1/r/core/services";

test("the Summary has seven tiles in the spec's order", () => {
  expect(tiles().map((t) => t.id)).toEqual([
    "cluster-ip",
    "node-port",
    "load-balancer",
    "external-name",
    "ingresses",
    "gateways",
    "policies",
  ]);
});

test("Services count by type, a Service without one is ClusterIP, and headless and Pending ones are named", () => {
  const all = tiles({
    services: ready([
      service("shop", "web", { type: "ClusterIP", clusterIP: "10.96.0.10" }),
      service("shop", "db", { type: "ClusterIP", clusterIP: "None" }),
      service("shop", "legacy", {}),
      service("shop", "debug", { type: "NodePort" }),
      service("shop", "edge", { type: "LoadBalancer" }, [
        { ip: "203.0.113.7" },
      ]),
      service("shop", "idle", { type: "LoadBalancer" }),
      service("shop", "ext", {
        type: "ExternalName",
        externalName: "db.example.com",
      }),
    ]),
  });
  expect(shown(tile(all, "cluster-ip"))).toEqual({
    id: "cluster-ip",
    icon: "network",
    label: "ClusterIP Services",
    number: "3",
    sub: "1 headless",
    tone: "neutral",
    to: SERVICES_LIST,
  });
  expect(shown(tile(all, "node-port"))).toEqual({
    id: "node-port",
    icon: "plug",
    label: "NodePort Services",
    number: "1",
    sub: "A port on every node",
    tone: "neutral",
    to: SERVICES_LIST,
  });
  expect(shown(tile(all, "load-balancer"))).toEqual({
    id: "load-balancer",
    icon: "load-balancer",
    label: "LoadBalancer Services",
    number: "2",
    sub: "1 Pending",
    tone: "warn",
    to: SERVICES_LIST,
  });
  expect(shown(tile(all, "external-name"))).toEqual({
    id: "external-name",
    icon: "external-link",
    label: "ExternalName Services",
    number: "1",
    sub: "Names outside the cluster",
    tone: "neutral",
    to: SERVICES_LIST,
  });
});

test("a type without Services reads None, and LoadBalancers that all have an address are ok", () => {
  const all = tiles({
    services: ready([
      service("shop", "edge", { type: "LoadBalancer" }, [
        { hostname: "lb.example.com" },
      ]),
      service("shop", "web", { type: "ClusterIP", clusterIP: "10.96.0.10" }),
    ]),
  });
  expect(tile(all, "cluster-ip")).toMatchObject({
    number: "1",
    sub: "Reached inside the cluster",
  });
  for (const id of ["node-port", "external-name"]) {
    expect(tile(all, id)).toMatchObject({
      number: "0",
      sub: "None",
      tone: "neutral",
    });
  }
  expect(tile(all, "load-balancer")).toMatchObject({
    number: "1",
    sub: "All have an address",
    tone: "ok",
  });
  expect(tile(tiles(), "load-balancer")).toMatchObject({
    number: "0",
    sub: "None",
    tone: "neutral",
  });
});

test("Ingresses warn while one lacks an address, are ok when all have one, and read None without any", () => {
  const two = tiles({
    ingresses: ready([
      ingress("shop", "web", [], {}, "198.51.100.4"),
      ingress("shop", "api", []),
    ]),
  });
  expect(shown(tile(two, "ingresses"))).toEqual({
    id: "ingresses",
    icon: "ingress",
    label: "Ingresses",
    number: "2",
    sub: "1 without an address",
    tone: "warn",
    to: "/cluster/c1/r/networking.k8s.io/ingresses",
  });
  const one = tiles({
    ingresses: ready([ingress("shop", "web", [], {}, "198.51.100.4")]),
  });
  expect(tile(one, "ingresses")).toMatchObject({
    number: "1",
    sub: "All have an address",
    tone: "ok",
  });
  expect(tile(tiles(), "ingresses")).toMatchObject({
    number: "0",
    sub: "None",
    tone: "neutral",
  });
});

test("Gateways and routes counts the routes the person may list and the Gateways not Programmed", () => {
  const all = tiles({
    gateways: ready([
      gateway("public", "True"),
      gateway("staging", "False"),
      gateway("new", null),
    ]),
    routes: [
      ready([route("shop", "a", [], []), route("shop", "b", [], [])]),
      ready([route("shop", "c", [], [])]),
      notServed("TLSRoutes"),
      forbidden("TCPRoutes"),
      ready([]),
    ],
  });
  expect(shown(tile(all, "gateways"))).toEqual({
    id: "gateways",
    icon: "split",
    label: "Gateways and routes",
    number: "3",
    sub: "3 routes · 2 not Programmed",
    tone: "warn",
    to: "/cluster/c1/r/gateway.networking.k8s.io/gateways",
  });
  const fine = tiles({
    gateways: ready([gateway("public", "True")]),
    routes: [ready([route("shop", "a", [], [])])],
  });
  expect(tile(fine, "gateways")).toMatchObject({
    number: "1",
    sub: "1 route",
    tone: "neutral",
  });
});

test("a cluster without Gateways says the Gateway API is not installed", () => {
  const all = tiles({
    gateways: notServed("Gateways"),
    routes: [
      notServed("HTTPRoutes"),
      notServed("GRPCRoutes"),
      notServed("TLSRoutes"),
      notServed("TCPRoutes"),
      notServed("UDPRoutes"),
    ],
  });
  expect(shown(tile(all, "gateways"))).toEqual({
    id: "gateways",
    icon: "split",
    label: "Gateways and routes",
    number: "—",
    sub: "Gateway API is not installed",
    tone: "neutral",
    to: null,
  });
});

test("the Gateways tile waits while a route list loads, and says why it cannot list Gateways", () => {
  expect(tile(tiles({ routes: [LOADING] }), "gateways")).toMatchObject({
    number: "—",
    sub: "Loading",
    tone: "neutral",
    to: "/cluster/c1/r/gateway.networking.k8s.io/gateways",
  });
  expect(
    tile(tiles({ gateways: forbidden("Gateways") }), "gateways"),
  ).toMatchObject({
    number: "—",
    sub: "You may not list Gateways",
    to: null,
  });
});

test("NetworkPolicies name the namespaces they sit in, or say all traffic is allowed", () => {
  const all = tiles({
    policies: ready([
      obj("shop", "deny-all"),
      obj("shop", "allow-web"),
      obj("payments", "deny-all"),
    ]),
  });
  expect(shown(tile(all, "policies"))).toEqual({
    id: "policies",
    icon: "shield-check",
    label: "NetworkPolicies",
    number: "3",
    sub: "In 2 namespaces",
    tone: "neutral",
    to: "/cluster/c1/r/networking.k8s.io/networkpolicies",
  });
  expect(
    tile(tiles({ policies: ready([obj("shop", "deny-all")]) }), "policies"),
  ).toMatchObject({ number: "1", sub: "In 1 namespace" });
  expect(tile(tiles(), "policies")).toMatchObject({
    number: "0",
    sub: "None, so all traffic is allowed",
    tone: "neutral",
  });
});

test("a list loading, forbidden or failing gives its tiles the waiting sub-lines", () => {
  const all = tiles({
    services: LOADING,
    ingresses: forbidden("Ingresses"),
    policies: FAILED,
  });
  for (const id of [
    "cluster-ip",
    "node-port",
    "load-balancer",
    "external-name",
  ]) {
    expect(tile(all, id)).toMatchObject({
      number: "—",
      sub: "Loading",
      tone: "neutral",
      to: SERVICES_LIST,
    });
  }
  expect(tile(all, "ingresses")).toMatchObject({
    number: "—",
    sub: "You may not list Ingresses",
    to: null,
  });
  expect(tile(all, "policies")).toMatchObject({
    number: "—",
    sub: "Could not list NetworkPolicies",
    to: "/cluster/c1/r/networking.k8s.io/networkpolicies",
  });
});

test("Endpoints ready counts every endpoint, ready unless it says it is not", () => {
  const { donut } = endpointsReady(
    [
      slice("shop", "web", [true, false]),
      slice("shop", "web", [null]),
      slice("shop", "db", [true]),
    ],
    [],
  );
  expect(donut).toEqual({
    key: "endpoints",
    name: "Endpoints",
    label: "Ready endpoints",
    pct: 75,
    used: "3",
    total: "4",
    unit: "",
    note: "3 EndpointSlices",
    level: "warning",
  });
  expect(
    endpointsReady([slice("shop", "db", [true, null])], []).donut,
  ).toMatchObject({
    pct: 100,
    used: "2",
    total: "2",
    note: "1 EndpointSlice",
    level: "nominal",
  });
  expect(endpointsReady([], []).donut).toMatchObject({
    pct: null,
    used: null,
    total: null,
    note: "0 EndpointSlices",
    level: "nominal",
  });
});

test("Services without ready endpoints go by namespace and name, match slices of their own namespace, and leave ExternalName out", () => {
  const services = [
    service("shop", "web", { type: "ClusterIP" }),
    service("shop", "db", { type: "ClusterIP", clusterIP: "None" }),
    service("shop", "idle", {}),
    service("shop", "ext", {
      type: "ExternalName",
      externalName: "db.example.com",
    }),
    service("payments", "api", { type: "LoadBalancer" }),
  ];
  const { dark } = endpointsReady(
    [
      slice("shop", "web", [false, false]),
      slice("shop", "db", [true]),
      // The label names `api`, but in shop: payments/api still has no endpoint.
      slice("shop", "api", [true]),
      slice("shop", null, [true]),
    ],
    services,
  );
  expect(dark.map((d) => [key(d.service), d.type, d.ready])).toEqual([
    ["payments/api", "LoadBalancer", "None"],
    ["shop/idle", "ClusterIP", "None"],
    ["shop/web", "ClusterIP", "0 of 2"],
  ]);
});

test("Ingresses and routes: a row per host, Ingresses first, then the route kinds in their order, each by namespace and name", () => {
  const rows = hostRows(
    [
      ingress("shop", "web", [
        {
          host: "shop.example.com",
          http: {
            paths: [
              { path: "/", backend: backend("web", { number: 80 }) },
              { path: "/api", backend: backend("api", { number: 8080 }) },
            ],
          },
        },
        {
          host: "www.example.com",
          http: {
            paths: [
              { path: "/home", backend: backend("home", { name: "http" }) },
            ],
          },
        },
      ]),
      ingress("payments", "pay", [
        {
          host: "pay.example.com",
          http: { paths: [{ backend: backend("pay", { number: 8080 }) }] },
        },
      ]),
    ],
    [
      {
        kind: "HTTPRoute",
        objects: [
          route(
            "shop",
            "store",
            ["store.example.com", "cart.example.com"],
            [
              {
                matches: [{ path: { type: "PathPrefix", value: "/cart" } }],
                backendRefs: [{ name: "cart", port: 8080 }],
              },
            ],
          ),
          route("payments", "checkout", ["checkout.example.com"], []),
        ],
      },
      {
        kind: "GRPCRoute",
        objects: [
          route(
            "shop",
            "rpc",
            ["rpc.example.com"],
            [
              {
                matches: [{ method: { service: "shop.Cart" } }],
                backendRefs: [{ name: "rpc" }],
              },
            ],
          ),
        ],
      },
      {
        kind: "TLSRoute",
        objects: [
          route(
            "shop",
            "tls",
            ["tls.example.com"],
            [{ backendRefs: [{ name: "tls", port: 443 }] }],
          ),
        ],
      },
      {
        kind: "TCPRoute",
        objects: [
          obj("shop", "db", {
            spec: { rules: [{ backendRefs: [{ name: "db", port: 5432 }] }] },
          }),
        ],
      },
    ],
  );
  expect(
    rows.map((r) => [r.host, r.path, r.backend, r.kind, key(r.object)]),
  ).toEqual([
    ["pay.example.com", "/", "pay:8080", "Ingress", "payments/pay"],
    ["shop.example.com", "/", "web:80", "Ingress", "shop/web"],
    ["www.example.com", "/home", "home:http", "Ingress", "shop/web"],
    ["checkout.example.com", "/", "—", "HTTPRoute", "payments/checkout"],
    ["store.example.com", "/cart", "cart:8080", "HTTPRoute", "shop/store"],
    ["cart.example.com", "/cart", "cart:8080", "HTTPRoute", "shop/store"],
    ["rpc.example.com", "shop.Cart", "rpc", "GRPCRoute", "shop/rpc"],
    ["tls.example.com", "—", "tls:443", "TLSRoute", "shop/tls"],
  ]);
});

test("an object without a host adds no row, and a rule without paths uses the default backend", () => {
  const rows = hostRows(
    [
      ingress("shop", "fallback", [{ host: "f.example.com" }], {
        defaultBackend: backend("fallback", { number: 80 }),
      }),
      ingress("shop", "nohost", [
        {
          http: {
            paths: [{ path: "/", backend: backend("x", { number: 80 }) }],
          },
        },
      ]),
      ingress("shop", "bare", [{ host: "bare.example.com" }]),
    ],
    [
      {
        kind: "HTTPRoute",
        objects: [
          route("shop", "plain", ["plain.example.com"], []),
          route(
            "shop",
            "unnamed",
            [],
            [{ backendRefs: [{ name: "x", port: 80 }] }],
          ),
        ],
      },
      {
        kind: "GRPCRoute",
        objects: [route("shop", "g", ["g.example.com"], [{}])],
      },
    ],
  );
  expect(rows.map((r) => [r.host, r.path, r.backend])).toEqual([
    ["bare.example.com", "/", "—"],
    ["f.example.com", "/", "fallback:80"],
    ["plain.example.com", "/", "—"],
    ["g.example.com", "—", "—"],
  ]);
});

test("a row's key names its kind, object and host, and a repeated host gets a number", () => {
  const rows = hostRows(
    [
      ingress("shop", "web", [
        { host: "shop.example.com" },
        { host: "shop.example.com" },
      ]),
    ],
    [
      {
        kind: "HTTPRoute",
        objects: [route("shop", "store", ["store.example.com"], [])],
      },
    ],
  );
  expect(hostRowKeys(rows)).toEqual([
    "Ingress/shop/web/shop.example.com",
    "Ingress/shop/web/shop.example.com#2",
    "HTTPRoute/shop/store/store.example.com",
  ]);
});

test("Load balancers list the LoadBalancer Services by namespace and name, with their addresses and ports", () => {
  const rows = loadBalancerRows([
    service("shop", "web", {
      type: "LoadBalancer",
      ports: [
        { port: 80, nodePort: 30080 },
        { port: 443, nodePort: 30443, protocol: "TCP" },
      ],
    }),
    service("shop", "edge", { type: "LoadBalancer", ports: [{ port: 443 }] }, [
      { ip: "203.0.113.7" },
      { hostname: "lb.example.com" },
    ]),
    service("shop", "internal", { type: "ClusterIP", ports: [{ port: 80 }] }),
    service("payments", "bare", { type: "LoadBalancer" }),
  ]);
  expect(rows.map((r) => [key(r.service), r.address, r.ports])).toEqual([
    ["payments/bare", null, "—"],
    ["shop/edge", "203.0.113.7, lb.example.com", "443/TCP"],
    ["shop/web", null, "80:30080/TCP,443:30443/TCP"],
  ]);
});

test("an external address is mono, and none reads Pending in the warning color", () => {
  expect(addressCell(null)).toEqual({ text: "Pending", tone: "warn" });
  expect(addressCell("203.0.113.7")).toEqual({
    text: "203.0.113.7",
    mono: true,
    title: "203.0.113.7",
  });
});

test("each table without rows says why, or that there is nothing to show", () => {
  expect(darkEmpty(ready([]), ready([]))).toEqual({
    title: "Every Service has a ready endpoint",
    text: "",
  });
  expect(darkEmpty(forbidden("EndpointSlices"), ready([]))).toEqual({
    title: "You may not list EndpointSlices",
    text: "",
  });
  expect(darkEmpty(ready([]), FAILED)).toEqual({
    title: "Could not list Services",
    text: "connection refused",
  });
  expect(routesEmpty(ready([]))).toEqual({
    title: "No Ingresses or routes",
    text: "Ingresses and HTTPRoutes, GRPCRoutes and TLSRoutes with hostnames show here.",
  });
  expect(routesEmpty(notServed("Ingresses"))).toEqual({
    title: "This cluster does not serve Ingresses",
    text: "",
  });
  expect(balancersEmpty(ready([]))).toEqual({
    title: "No LoadBalancer Services",
    text: "A Service of type LoadBalancer gets its external address from the cloud provider.",
  });
  expect(balancersEmpty(forbidden("Services"))).toEqual({
    title: "You may not list Services",
    text: "",
  });
});
