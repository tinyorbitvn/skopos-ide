import { useMemo } from "react";
import { Check, LoadBalancer, Split } from "../../design/icons";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import { findResource } from "../../stores/resources";
import { useClusterContext } from "../cluster/ClusterLayout";
import {
  CapacityRow,
  OverviewCard,
  OverviewCell,
  type OverviewColumn,
  OverviewGrid,
  OverviewPage,
  type OverviewRow,
  OverviewTable,
} from "../overview";
import type { ListView } from "../workloads/counts";
import {
  addressCell,
  balancersEmpty,
  darkEmpty,
  endpointsReady,
  GATEWAY_GROUP,
  hostRowKeys,
  hostRows,
  loadBalancerRows,
  NO_ENDPOINTS,
  networkTiles,
  ROUTE_KINDS,
  routesEmpty,
} from "./networkModel";
import styles from "./Sections.module.css";
import { useSectionShared, useSectionView } from "./sectionLists";
import { objectKey } from "./text";
import { TileGrid } from "./tiles";
import { useOverviewDrawer } from "./useOverviewDrawer";

/** The kinds the page opens in its drawer (spec §3.5), found in discovery when served. */
const OPENABLE_KINDS: readonly (readonly [group: string, plural: string])[] = [
  ["", "services"],
  ["networking.k8s.io", "ingresses"],
  ...ROUTE_KINDS.map((k) => [GATEWAY_GROUP, k.plural] as const),
];

const [HTTP_ROUTE, GRPC_ROUTE, TLS_ROUTE, TCP_ROUTE, UDP_ROUTE] = ROUTE_KINDS;

const DARK_COLUMNS: OverviewColumn[] = [
  { head: "Service", width: "minmax(0, 1fr)" },
  { head: "Type", width: "96px" },
  { head: "Ready", width: "64px", align: "end" },
];

const ROUTE_COLUMNS: OverviewColumn[] = [
  { head: "Host", width: "minmax(0, 1.2fr)" },
  { head: "Path", width: "minmax(0, 1fr)" },
  { head: "Backend", width: "minmax(0, 1fr)" },
];

const BALANCER_COLUMNS: OverviewColumn[] = [
  { head: "Service", width: "minmax(0, 1fr)" },
  { head: "External address", width: "minmax(0, 1fr)" },
  { head: "Ports", width: "minmax(0, 0.7fr)" },
];

/** A ready list's objects, or none. */
const itemsOf = (view: ListView): KubeObject[] =>
  view.state === "ready" ? view.items : [];

/**
 * The Network overview (spec §3.5): the Summary tiles, Endpoints ready, Ingresses and routes,
 * and Load balancers, under the lists' namespace selection.
 */
export function NetworkOverview() {
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const discovery = useMemo(
    () => ({ loading: resourcesLoading, error: resourcesError }),
    [resourcesLoading, resourcesError],
  );
  const shared = useSectionShared(clusterId, resources, discovery);
  const services = useSectionView(shared, "Services", "", "services");
  const slices = useSectionView(
    shared,
    "EndpointSlices",
    "discovery.k8s.io",
    "endpointslices",
  );
  const ingresses = useSectionView(
    shared,
    "Ingresses",
    "networking.k8s.io",
    "ingresses",
  );
  const policies = useSectionView(
    shared,
    "NetworkPolicies",
    "networking.k8s.io",
    "networkpolicies",
  );
  const gateways = useSectionView(
    shared,
    "Gateways",
    GATEWAY_GROUP,
    "gateways",
  );
  // One call per route kind, in ROUTE_KINDS' order: hooks may not loop (R2).
  const http = useSectionView(
    shared,
    HTTP_ROUTE.label,
    GATEWAY_GROUP,
    HTTP_ROUTE.plural,
  );
  const grpc = useSectionView(
    shared,
    GRPC_ROUTE.label,
    GATEWAY_GROUP,
    GRPC_ROUTE.plural,
  );
  const tls = useSectionView(
    shared,
    TLS_ROUTE.label,
    GATEWAY_GROUP,
    TLS_ROUTE.plural,
  );
  const tcp = useSectionView(
    shared,
    TCP_ROUTE.label,
    GATEWAY_GROUP,
    TCP_ROUTE.plural,
  );
  const udp = useSectionView(
    shared,
    UDP_ROUTE.label,
    GATEWAY_GROUP,
    UDP_ROUTE.plural,
  );
  const routes = useMemo(
    () => [http, grpc, tls, tcp, udp],
    [http, grpc, tls, tcp, udp],
  );

  const openable = useMemo(
    () =>
      OPENABLE_KINDS.flatMap(([group, plural]): ResourceRef[] => {
        const info = findResource(resources, group, plural);
        return info === undefined ? [] : [info.resource];
      }),
    [resources],
  );
  const drawer = useOverviewDrawer(clusterId, resources, openable);
  /** Opens `object` of `kind` in the drawer, when discovery serves that kind. */
  const opener = (kind: string, object: KubeObject) => {
    const ref = openable.find((r) => r.kind === kind);
    return ref === undefined
      ? undefined
      : () => drawer.open(ref, objectKey(object));
  };

  const tiles = useMemo(
    () =>
      networkTiles({
        clusterId,
        services,
        ingresses,
        gateways,
        routes,
        policies,
      }),
    [clusterId, services, ingresses, gateways, routes, policies],
  );
  const endpoints = useMemo(
    () =>
      slices.state === "ready"
        ? endpointsReady(slices.items, itemsOf(services))
        : null,
    [slices, services],
  );
  const hosts = useMemo(
    () =>
      hostRows(
        itemsOf(ingresses),
        ROUTE_KINDS.map((k, i) => ({
          kind: k.kind,
          objects: itemsOf(routes[i]),
        })),
      ),
    [ingresses, routes],
  );
  const balancers = useMemo(
    () => loadBalancerRows(itemsOf(services)),
    [services],
  );

  const darkRows = (endpoints?.dark ?? []).map(
    ({ service, type, ready }): OverviewRow => ({
      key: objectKey(service),
      name: service.metadata.name,
      sub: service.metadata.namespace ?? "",
      title: objectKey(service),
      onOpen: opener("Service", service),
      cells: [{ text: type }, { text: ready }],
    }),
  );
  const keys = hostRowKeys(hosts);
  const routeRows = hosts.map(
    (h, i): OverviewRow => ({
      key: keys[i],
      name: h.host,
      sub: `${h.kind} ${objectKey(h.object)}`,
      title: h.host,
      onOpen: opener(h.kind, h.object),
      cells: [
        { text: h.path, mono: true, title: h.path },
        { text: h.backend, mono: true, title: h.backend },
      ],
    }),
  );
  const balancerRows = balancers.map(
    ({ service, address, ports }): OverviewRow => ({
      key: objectKey(service),
      name: service.metadata.name,
      sub: service.metadata.namespace ?? "",
      title: objectKey(service),
      onOpen: opener("Service", service),
      cells: [addressCell(address), { text: ports, mono: true }],
    }),
  );

  return (
    <OverviewPage
      title="Network overview"
      testId="network-overview"
      namespaces={shared[3]}
      onKeyDown={drawer.onKeyDown}
    >
      <OverviewGrid>
        <OverviewCell span={12}>
          <OverviewCard title="Summary" testId="network-overview-card-summary">
            <div className={styles.networkSummary}>
              <TileGrid tiles={tiles} />
            </div>
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={5}>
          <OverviewCard
            title="Endpoints ready"
            testId="network-overview-card-endpoints"
          >
            <CapacityRow items={[endpoints?.donut ?? NO_ENDPOINTS]} />
            <OverviewTable
              id="network-dark-services"
              title="Services without ready endpoints"
              label="Services without ready endpoints"
              columns={DARK_COLUMNS}
              rows={darkRows}
              loading={
                slices.state === "loading" || services.state === "loading"
              }
              empty={{ icon: Check, ...darkEmpty(slices, services) }}
            />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={7}>
          <OverviewCard
            title="Ingresses and routes"
            testId="network-overview-card-routes"
          >
            <OverviewTable
              id="network-routes"
              label="Ingresses and routes"
              columns={ROUTE_COLUMNS}
              rows={routeRows}
              minWidth={420}
              loading={
                ingresses.state === "loading" ||
                routes.some((r) => r.state === "loading")
              }
              empty={{ icon: Split, ...routesEmpty(ingresses) }}
            />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={12}>
          <OverviewCard
            title="Load balancers"
            testId="network-overview-card-load-balancers"
          >
            <OverviewTable
              id="network-load-balancers"
              label="Load balancers"
              columns={BALANCER_COLUMNS}
              rows={balancerRows}
              loading={services.state === "loading"}
              empty={{ icon: LoadBalancer, ...balancersEmpty(services) }}
            />
          </OverviewCard>
        </OverviewCell>
      </OverviewGrid>
      {drawer.drawer}
    </OverviewPage>
  );
}
