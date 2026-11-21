import {
  ExternalLink,
  Ingress,
  LoadBalancer,
  Network,
  Plug,
  ShieldCheck,
  Split,
} from "../../design/icons";
import { conditionStatus } from "../../kinds/gateway/gateway";
import { resourcePath } from "../../kinds/nav";
import {
  backendText,
  type IngressBackend,
  servicePorts,
} from "../../kinds/network/network";
import type { KubeObject } from "../../kinds/objects";
import { percentOf } from "../../kinds/usageColumns";
import type { CapacityItem, OverviewCellValue } from "../overview";
import type { ListView } from "../workloads/counts";
import { readyTile, type TileBase, unavailableState } from "./namespacesModel";
import { byNamespaceName, countOf, formatCount, objectKey } from "./text";
import { type SectionTile, waitingTile } from "./tiles";

/** The Gateway API's group: Gateways and the five route kinds. */
export const GATEWAY_GROUP = "gateway.networking.k8s.io";

/** A Gateway API route kind the page reads. */
export interface RouteKind {
  /** The kind, as the rows' sub-lines and discovery name it. */
  kind: string;
  plural: string;
  /** The list's name in reasons, as "HTTPRoutes". */
  label: string;
}

/** The route kinds in spec §3.5's order: the Ingresses and routes rows follow it. */
export const ROUTE_KINDS: readonly RouteKind[] = [
  { kind: "HTTPRoute", plural: "httproutes", label: "HTTPRoutes" },
  { kind: "GRPCRoute", plural: "grpcroutes", label: "GRPCRoutes" },
  { kind: "TLSRoute", plural: "tlsroutes", label: "TLSRoutes" },
  { kind: "TCPRoute", plural: "tcproutes", label: "TCPRoutes" },
  { kind: "UDPRoute", plural: "udproutes", label: "UDPRoutes" },
];

/** The label an EndpointSlice names its Service with. */
const SERVICE_NAME_LABEL = "kubernetes.io/service-name";
const DASH = "—";

interface LoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

interface Endpoint {
  conditions?: { ready?: boolean | null };
}

interface IngressPath {
  path?: string;
  backend?: IngressBackend;
}

interface IngressRule {
  host?: string;
  http?: { paths?: IngressPath[] };
}

interface RouteMatch {
  path?: { value?: string };
  method?: { service?: string };
}

interface BackendRef {
  name?: string;
  port?: number;
}

interface RouteRule {
  matches?: RouteMatch[];
  backendRefs?: BackendRef[];
}

function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** A Service's `spec.type`; the API defaults it to ClusterIP. */
export function serviceType(o: KubeObject): string {
  const type = o.spec?.type;
  return typeof type === "string" && type !== "" ? type : "ClusterIP";
}

/** The IPs and hostnames of `status.loadBalancer.ingress`, of a Service or an Ingress. */
function addressesOf(o: KubeObject): string[] {
  return list<LoadBalancerIngress>(o.status?.loadBalancer?.ingress)
    .map((i) => i?.ip || i?.hostname)
    .filter((v): v is string => typeof v === "string" && v !== "");
}

// ---- Summary (spec §3.5)

/** A count's sub-line, or `None` at zero. */
const orNone = (n: number, text: string) => (n === 0 ? "None" : text);

/** The four Services tiles, by `spec.type`. */
function serviceTiles(view: ListView, to: string): SectionTile[] {
  const base = (
    id: string,
    icon: TileBase["icon"],
    label: string,
  ): TileBase => ({ id, icon, label, plural: "Services", to });
  const clusterIpBase = base("cluster-ip", Network, "ClusterIP Services");
  const nodePortBase = base("node-port", Plug, "NodePort Services");
  const loadBalancerBase = base(
    "load-balancer",
    LoadBalancer,
    "LoadBalancer Services",
  );
  const externalNameBase = base(
    "external-name",
    ExternalLink,
    "ExternalName Services",
  );
  if (view.state !== "ready") {
    return [
      clusterIpBase,
      nodePortBase,
      loadBalancerBase,
      externalNameBase,
    ].map((b) => waitingTile(view, b));
  }
  const of = (type: string) =>
    view.items.filter((s) => serviceType(s) === type);
  const clusterIp = of("ClusterIP");
  const nodePort = of("NodePort");
  const loadBalancer = of("LoadBalancer");
  const externalName = of("ExternalName");
  const headless = clusterIp.filter((s) => s.spec?.clusterIP === "None").length;
  const pending = loadBalancer.filter(
    (s) => addressesOf(s).length === 0,
  ).length;
  return [
    readyTile(
      clusterIpBase,
      clusterIp.length,
      orNone(
        clusterIp.length,
        headless > 0
          ? `${formatCount(headless)} headless`
          : "Reached inside the cluster",
      ),
      "neutral",
    ),
    readyTile(
      nodePortBase,
      nodePort.length,
      orNone(nodePort.length, "A port on every node"),
      "neutral",
    ),
    readyTile(
      loadBalancerBase,
      loadBalancer.length,
      orNone(
        loadBalancer.length,
        pending > 0 ? `${formatCount(pending)} Pending` : "All have an address",
      ),
      pending > 0 ? "warn" : loadBalancer.length > 0 ? "ok" : "neutral",
    ),
    readyTile(
      externalNameBase,
      externalName.length,
      orNone(externalName.length, "Names outside the cluster"),
      "neutral",
    ),
  ];
}

function ingressTile(view: ListView, base: TileBase): SectionTile {
  if (view.state !== "ready") return waitingTile(view, base);
  const n = view.items.length;
  const bare = view.items.filter((o) => addressesOf(o).length === 0).length;
  return readyTile(
    base,
    n,
    orNone(
      n,
      bare > 0
        ? `${formatCount(bare)} without an address`
        : "All have an address",
    ),
    bare > 0 ? "warn" : n > 0 ? "ok" : "neutral",
  );
}

/**
 * Gateways and routes: the Gateways, the routes of the kinds the cluster serves and the person
 * may list, and the Gateways whose `Programmed` condition is not True. Without the Gateway
 * API the tile says so (spec §3.1, §10).
 */
function gatewaysTile(
  gateways: ListView,
  routes: readonly ListView[],
  base: TileBase,
): SectionTile {
  if (gateways.state === "unavailable" && gateways.cause === "notServed") {
    return {
      ...waitingTile(gateways, base),
      sub: "Gateway API is not installed",
    };
  }
  if (gateways.state !== "ready") return waitingTile(gateways, base);
  if (routes.some((r) => r.state === "loading")) {
    return waitingTile({ state: "loading" }, base);
  }
  const routeCount = routes.reduce(
    (n, r) => n + (r.state === "ready" ? r.items.length : 0),
    0,
  );
  const off = gateways.items.filter(
    (g) => conditionStatus(g, "Programmed")?.label !== "True",
  ).length;
  return readyTile(
    base,
    gateways.items.length,
    `${countOf(routeCount, "route")}${off > 0 ? ` · ${formatCount(off)} not Programmed` : ""}`,
    off > 0 ? "warn" : "neutral",
  );
}

function policiesTile(view: ListView, base: TileBase): SectionTile {
  if (view.state !== "ready") return waitingTile(view, base);
  const n = view.items.length;
  const spaces = new Set(view.items.map((o) => o.metadata.namespace ?? ""))
    .size;
  return readyTile(
    base,
    n,
    n === 0
      ? "None, so all traffic is allowed"
      : `In ${countOf(spaces, "namespace")}`,
    "neutral",
  );
}

/**
 * The Summary's seven tiles (spec §3.5), in their order. `routes` holds one view per route
 * kind; those the cluster does not serve or the person may not list are skipped.
 */
export function networkTiles(input: {
  clusterId: string;
  services: ListView;
  ingresses: ListView;
  gateways: ListView;
  routes: ListView[];
  policies: ListView;
}): SectionTile[] {
  const { clusterId } = input;
  return [
    ...serviceTiles(input.services, resourcePath(clusterId, "", "services")),
    ingressTile(input.ingresses, {
      id: "ingresses",
      icon: Ingress,
      label: "Ingresses",
      plural: "Ingresses",
      to: resourcePath(clusterId, "networking.k8s.io", "ingresses"),
    }),
    gatewaysTile(input.gateways, input.routes, {
      id: "gateways",
      icon: Split,
      label: "Gateways and routes",
      plural: "Gateways",
      to: resourcePath(clusterId, GATEWAY_GROUP, "gateways"),
    }),
    policiesTile(input.policies, {
      id: "policies",
      icon: ShieldCheck,
      label: "NetworkPolicies",
      plural: "NetworkPolicies",
      to: resourcePath(clusterId, "networking.k8s.io", "networkpolicies"),
    }),
  ];
}

// ---- Endpoints ready (spec §3.5, §5)

/** The Endpoints donut before its slices are read. */
export const NO_ENDPOINTS: CapacityItem = {
  key: "endpoints",
  name: "Endpoints",
  label: "Ready endpoints",
  pct: null,
  used: null,
  total: null,
  unit: "",
  note: null,
};

/**
 * Ready endpoints of all endpoints in the slices, and the Services other than ExternalName
 * whose slices (by `kubernetes.io/service-name`, in their namespace) hold no ready one. An
 * endpoint is ready unless its `conditions.ready` is false.
 */
export function endpointsReady(
  slices: readonly KubeObject[],
  services: readonly KubeObject[],
): {
  donut: CapacityItem;
  dark: { service: KubeObject; type: string; ready: string }[];
} {
  let all = 0;
  let up = 0;
  const byService = new Map<string, { all: number; up: number }>();
  for (const slice of slices) {
    const owner = slice.metadata.labels?.[SERVICE_NAME_LABEL];
    const key =
      owner === undefined ? null : `${slice.metadata.namespace ?? ""}/${owner}`;
    for (const endpoint of list<Endpoint>(slice.endpoints)) {
      const ready = endpoint?.conditions?.ready !== false;
      all += 1;
      if (ready) up += 1;
      if (key === null) continue;
      const tally = byService.get(key) ?? { all: 0, up: 0 };
      tally.all += 1;
      if (ready) tally.up += 1;
      byService.set(key, tally);
    }
  }
  const pct = percentOf({ used: up, total: all });
  const donut: CapacityItem = {
    ...NO_ENDPOINTS,
    pct,
    used: pct === null ? null : formatCount(up),
    total: pct === null ? null : formatCount(all),
    note: countOf(slices.length, "EndpointSlice"),
    level: up < all ? "warning" : "nominal",
  };
  const dark = services
    .filter((s) => serviceType(s) !== "ExternalName")
    .filter((s) => (byService.get(objectKey(s))?.up ?? 0) === 0)
    .sort(byNamespaceName)
    .map((service) => {
      const total = byService.get(objectKey(service))?.all ?? 0;
      return {
        service,
        type: serviceType(service),
        ready: total === 0 ? "None" : `0 of ${formatCount(total)}`,
      };
    });
  return { donut, dark };
}

/** Services without ready endpoints, without rows: why, or that every Service has one. */
export function darkEmpty(
  slices: ListView,
  services: ListView,
): { title: string; text: string } {
  if (slices.state === "unavailable") {
    return unavailableState(slices, "EndpointSlices");
  }
  if (services.state === "unavailable") {
    return unavailableState(services, "Services");
  }
  return { title: "Every Service has a ready endpoint", text: "" };
}

// ---- Ingresses and routes (spec §3.5)

export interface HostRow {
  host: string;
  path: string;
  backend: string;
  object: KubeObject;
  kind: string;
}

/** A row per `spec.rules[].host`: the rule's first path and its backend Service. */
function ingressHostRows(o: KubeObject): HostRow[] {
  const fallback: IngressBackend | undefined = o.spec?.defaultBackend;
  return list<IngressRule>(o.spec?.rules).flatMap((rule): HostRow[] => {
    const host = rule?.host;
    if (typeof host !== "string" || host === "") return [];
    const first: IngressPath | undefined = list<IngressPath>(
      rule.http?.paths,
    )[0];
    return [
      {
        host,
        path: first?.path || "/",
        backend: backendText(first?.backend ?? fallback) || DASH,
        object: o,
        kind: "Ingress",
      },
    ];
  });
}

/** HTTPRoute: the first path match; GRPCRoute: the first match's service; others: none. */
function routePath(kind: string, rule: RouteRule | undefined): string {
  const match: RouteMatch | undefined = list<RouteMatch>(rule?.matches)[0];
  if (kind === "HTTPRoute") return match?.path?.value || "/";
  if (kind === "GRPCRoute") return match?.method?.service || DASH;
  return DASH;
}

/** The first `backendRefs` entry as `<name>:<port>`, its name without a port, or `—`. */
function routeBackend(rule: RouteRule | undefined): string {
  const ref: BackendRef | undefined = list<BackendRef>(rule?.backendRefs)[0];
  if (!ref?.name) return DASH;
  return typeof ref.port === "number" ? `${ref.name}:${ref.port}` : ref.name;
}

/** A row per `spec.hostnames[]`, from the route's first rule. */
function routeHostRows(kind: string, o: KubeObject): HostRow[] {
  const rule: RouteRule | undefined = list<RouteRule>(o.spec?.rules)[0];
  const path = routePath(kind, rule);
  const backend = routeBackend(rule);
  return list<unknown>(o.spec?.hostnames)
    .filter((h): h is string => typeof h === "string" && h !== "")
    .map((host) => ({ host, path, backend, object: o, kind }));
}

/**
 * Ingresses and routes (spec §3.5): one row per host, Ingresses first, then the route kinds
 * in the order given, each by namespace and name. An object without a host adds no row.
 */
export function hostRows(
  ingresses: readonly KubeObject[],
  routes: { kind: string; objects: readonly KubeObject[] }[],
): HostRow[] {
  return [
    ...[...ingresses].sort(byNamespaceName).flatMap(ingressHostRows),
    ...routes.flatMap(({ kind, objects }) =>
      [...objects].sort(byNamespaceName).flatMap((o) => routeHostRows(kind, o)),
    ),
  ];
}

/** Each row's key, `<kind>/<namespace>/<name>/<host>`, and `#2`… when a host repeats. */
export function hostRowKeys(rows: readonly HostRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map(({ host, object, kind }) => {
    const key = `${kind}/${objectKey(object)}/${host}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? key : `${key}#${n}`;
  });
}

/** Ingresses and routes without rows: why it cannot read the Ingresses, or that there are none. */
export function routesEmpty(ingresses: ListView): {
  title: string;
  text: string;
} {
  if (ingresses.state === "unavailable") {
    return unavailableState(ingresses, "Ingresses");
  }
  return {
    title: "No Ingresses or routes",
    text: "Ingresses and HTTPRoutes, GRPCRoutes and TLSRoutes with hostnames show here.",
  };
}

// ---- Load balancers (spec §3.5)

/** The LoadBalancer Services by namespace and name, with their addresses (null: Pending) and ports. */
export function loadBalancerRows(
  services: readonly KubeObject[],
): { service: KubeObject; address: string | null; ports: string }[] {
  return services
    .filter((s) => serviceType(s) === "LoadBalancer")
    .sort(byNamespaceName)
    .map((service) => {
      const addresses = addressesOf(service);
      return {
        service,
        address: addresses.length > 0 ? addresses.join(", ") : null,
        ports: servicePorts(service) || DASH,
      };
    });
}

/** The External address cell: the addresses in the mono face, or Pending in the warning color. */
export function addressCell(address: string | null): OverviewCellValue {
  return address === null
    ? { text: "Pending", tone: "warn" }
    : { text: address, mono: true, title: address };
}

/** Load balancers without rows: why it cannot read the Services, or that there are none. */
export function balancersEmpty(services: ListView): {
  title: string;
  text: string;
} {
  if (services.state === "unavailable") {
    return unavailableState(services, "Services");
  }
  return {
    title: "No LoadBalancer Services",
    text: "A Service of type LoadBalancer gets its external address from the cloud provider.",
  };
}
