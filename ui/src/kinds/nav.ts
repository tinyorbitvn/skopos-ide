import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";

export interface NavResource {
  type: "resource";
  label: string;
  /** The API group; "" is the core group. */
  group: string;
  plural: string;
}

/** A screen of the cluster that is not a resource list, at `/cluster/:id/<path>`. */
export interface NavRoute {
  type: "route";
  label: string;
  path: string;
}

export type NavItem = NavResource | NavRoute;

/** A key for an item, unique in the sidebar. */
export function navItemKey(item: NavItem): string {
  return item.type === "route"
    ? `route:${item.path}`
    : `${item.group}/${item.plural}`;
}

export interface NavSection {
  id: string;
  label: string;
  /** A first "Overview" entry that links to `/cluster/:id/<overview>`. */
  overview?: string;
  items: NavItem[];
}

function r(label: string, group: string, plural: string): NavResource {
  return { type: "resource", label, group, plural };
}

const GATEWAY = "gateway.networking.k8s.io";
const GATEWAY_EXPERIMENTAL = "gateway.networking.x-k8s.io";
const ARGO = "argoproj.io";
/** Dynamic Resource Allocation: Device Resources lists its kinds. */
const RESOURCE = "resource.k8s.io";

/** The Gateway API's standard and experimental groups. Network lists every served kind of both (spec M3). */
export const GATEWAY_GROUPS: ReadonlySet<string> = new Set([
  GATEWAY,
  GATEWAY_EXPERIMENTAL,
]);

/**
 * The sidebar sections of F4, in order. Overview is the cluster home route and not
 * a resource. The Workloads Overview entry links to the Workloads overview (F17). Port Forwarding and Helm's
 * Charts and Releases are routes of the cluster screen, not resource kinds. Custom Resources starts with Definitions; the
 * entries for each CRD are added by `customResourceGroups`. Helm and Argo CD come right under Nodes (spec M1). The Gateway
 * API kinds are under Network, where `visibleSections` adds the other served kinds of `GATEWAY_GROUPS` (spec M2, M3), and
 * Argo CD has its own section (spec G §3), as do the Dynamic Resource Allocation kinds (Device Resources); their items hide
 * where the cluster does not serve them.
 */
export const NAV_SECTIONS: NavSection[] = [
  { id: "nodes", label: "Nodes", items: [r("Nodes", "", "nodes")] },
  {
    id: "helm",
    label: "Helm",
    items: [
      { type: "route", label: "Charts", path: "helm/charts" },
      { type: "route", label: "Releases", path: "helm/releases" },
    ],
  },
  {
    id: "argocd",
    label: "Argo CD",
    items: [
      r("Applications", ARGO, "applications"),
      r("ApplicationSets", ARGO, "applicationsets"),
      r("AppProjects", ARGO, "appprojects"),
    ],
  },
  {
    id: "workloads",
    label: "Workloads",
    overview: "workloads",
    items: [
      r("Pods", "", "pods"),
      r("Deployments", "apps", "deployments"),
      r("DaemonSets", "apps", "daemonsets"),
      r("StatefulSets", "apps", "statefulsets"),
      r("ReplicaSets", "apps", "replicasets"),
      r("Jobs", "batch", "jobs"),
      r("CronJobs", "batch", "cronjobs"),
    ],
  },
  {
    id: "config",
    label: "Config",
    items: [
      r("ConfigMaps", "", "configmaps"),
      r("Secrets", "", "secrets"),
      r("ResourceQuotas", "", "resourcequotas"),
      r("LimitRanges", "", "limitranges"),
      r("HorizontalPodAutoscalers", "autoscaling", "horizontalpodautoscalers"),
      r("PodDisruptionBudgets", "policy", "poddisruptionbudgets"),
      r("PriorityClasses", "scheduling.k8s.io", "priorityclasses"),
      r("RuntimeClasses", "node.k8s.io", "runtimeclasses"),
      r("Leases", "coordination.k8s.io", "leases"),
      r(
        "MutatingWebhookConfigurations",
        "admissionregistration.k8s.io",
        "mutatingwebhookconfigurations",
      ),
      r(
        "ValidatingWebhookConfigurations",
        "admissionregistration.k8s.io",
        "validatingwebhookconfigurations",
      ),
    ],
  },
  {
    id: "network",
    label: "Network",
    items: [
      r("Services", "", "services"),
      r("EndpointSlices", "discovery.k8s.io", "endpointslices"),
      r("Ingresses", "networking.k8s.io", "ingresses"),
      r("IngressClasses", "networking.k8s.io", "ingressclasses"),
      r("NetworkPolicies", "networking.k8s.io", "networkpolicies"),
      r("GatewayClasses", GATEWAY, "gatewayclasses"),
      r("Gateways", GATEWAY, "gateways"),
      r("ListenerSets", GATEWAY, "listenersets"),
      r("HTTPRoutes", GATEWAY, "httproutes"),
      r("GRPCRoutes", GATEWAY, "grpcroutes"),
      r("TLSRoutes", GATEWAY, "tlsroutes"),
      r("TCPRoutes", GATEWAY, "tcproutes"),
      r("UDPRoutes", GATEWAY, "udproutes"),
      r("BackendTLSPolicies", GATEWAY, "backendtlspolicies"),
      r("ReferenceGrants", GATEWAY, "referencegrants"),
      { type: "route", label: "Port Forwarding", path: "port-forwards" },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    items: [
      r("PersistentVolumeClaims", "", "persistentvolumeclaims"),
      r("PersistentVolumes", "", "persistentvolumes"),
      r("StorageClasses", "storage.k8s.io", "storageclasses"),
    ],
  },
  {
    id: "devices",
    label: "Device Resources",
    items: [
      r("ResourceClaims", RESOURCE, "resourceclaims"),
      r("ResourceClaimTemplates", RESOURCE, "resourceclaimtemplates"),
      r("DeviceClasses", RESOURCE, "deviceclasses"),
      r("ResourceSlices", RESOURCE, "resourceslices"),
    ],
  },
  {
    id: "namespaces",
    label: "Namespaces",
    items: [r("Namespaces", "", "namespaces")],
  },
  { id: "events", label: "Events", items: [r("Events", "", "events")] },
  {
    id: "access",
    label: "Access Control",
    items: [
      r("ServiceAccounts", "", "serviceaccounts"),
      r("ClusterRoles", "rbac.authorization.k8s.io", "clusterroles"),
      r("Roles", "rbac.authorization.k8s.io", "roles"),
      r(
        "ClusterRoleBindings",
        "rbac.authorization.k8s.io",
        "clusterrolebindings",
      ),
      r("RoleBindings", "rbac.authorization.k8s.io", "rolebindings"),
    ],
  },
  {
    id: "custom",
    label: "Custom Resources",
    items: [
      r("Definitions", "apiextensions.k8s.io", "customresourcedefinitions"),
    ],
  },
];

/** API groups that ship with Kubernetes. Resources in any other group are custom. */
export const BUILTIN_GROUPS: ReadonlySet<string> = new Set([
  "",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "apps",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "autoscaling",
  "batch",
  "certificates.k8s.io",
  "coordination.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "internal.apiserver.k8s.io",
  "networking.k8s.io",
  "node.k8s.io",
  "policy",
  "rbac.authorization.k8s.io",
  "resource.k8s.io",
  "scheduling.k8s.io",
  "storage.k8s.io",
  "storagemigration.k8s.io",
]);

export interface CrdGroup {
  group: string;
  items: { label: string; plural: string }[];
}

function listable(resources: ApiResourceInfo[]): Set<string> {
  const out = new Set<string>();
  for (const info of resources) {
    if (info.canList) out.add(`${info.resource.group}/${info.resource.plural}`);
  }
  return out;
}

/**
 * A kind made plural (spec M4): `es` after a final s, x, z, ch or sh, `ies` in place of a
 * final y after a consonant, otherwise `s`.
 */
export function pluralKind(kind: string): string {
  if (/(s|x|z|ch|sh)$/i.test(kind)) return `${kind}es`;
  if (/[^aeiou]y$/i.test(kind)) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

/** `group/plural` of every resource a section lists; Custom Resources leaves them out. */
const NAV_RESOURCE_KEYS: ReadonlySet<string> = new Set(
  NAV_SECTIONS.flatMap((s) =>
    s.items.filter((i) => i.type === "resource").map(navItemKey),
  ),
);

/**
 * The listable kinds of `GATEWAY_GROUPS` that Network does not list itself, named after
 * their kind and sorted by that name (spec M3).
 */
function otherGatewayItems(resources: ApiResourceInfo[]): NavResource[] {
  return resources
    .filter(
      (info) =>
        GATEWAY_GROUPS.has(info.resource.group) &&
        info.canList &&
        !NAV_RESOURCE_KEYS.has(
          `${info.resource.group}/${info.resource.plural}`,
        ),
    )
    .map((info) =>
      r(
        pluralKind(info.resource.kind),
        info.resource.group,
        info.resource.plural,
      ),
    )
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Removes the items that are not served or not listable, then empty sections. Network
 * also gets the other served Gateway API kinds, just before Port Forwarding.
 */
export function visibleSections(resources: ApiResourceInfo[]): NavSection[] {
  const ok = listable(resources);
  const gateway = otherGatewayItems(resources);
  return NAV_SECTIONS.map((section) => {
    // A route needs no resource to list, so it always shows.
    const items = section.items.filter(
      (i) => i.type === "route" || ok.has(`${i.group}/${i.plural}`),
    );
    if (section.id !== "network" || gateway.length === 0) {
      return { ...section, items };
    }
    const route = items.findIndex((i) => i.type === "route");
    const at = route === -1 ? items.length : route;
    return {
      ...section,
      items: [...items.slice(0, at), ...gateway, ...items.slice(at)],
    };
  }).filter((section) => section.items.length > 0);
}

/**
 * Listable custom resources grouped by API group, with groups and items sorted.
 * Resources that a section lists are left out, one by one, so other kinds of their group
 * stay. Both Gateway API groups are left out whole: Network lists their kinds (spec M5).
 */
export function customResourceGroups(resources: ApiResourceInfo[]): CrdGroup[] {
  const groups = new Map<string, CrdGroup>();
  for (const info of resources) {
    const { group, plural, kind } = info.resource;
    if (
      BUILTIN_GROUPS.has(group) ||
      GATEWAY_GROUPS.has(group) ||
      !info.canList ||
      NAV_RESOURCE_KEYS.has(`${group}/${plural}`)
    ) {
      continue;
    }
    const entry = groups.get(group) ?? { group, items: [] };
    entry.items.push({ label: kind, plural });
    groups.set(group, entry);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    a.group.localeCompare(b.group),
  );
  for (const g of sorted) {
    g.items.sort((a, b) => a.label.localeCompare(b.label));
  }
  return sorted;
}

/** The URL segment for an API group: the core group is "core". */
export function groupSegment(group: string): string {
  return group === "" ? "core" : group;
}

/** The API group for a URL segment. */
export function groupFromSegment(segment: string): string {
  return segment === "core" ? "" : segment;
}

export function resourcePath(
  clusterId: string,
  group: string,
  plural: string,
): string {
  return `/cluster/${encodeURIComponent(clusterId)}/r/${encodeURIComponent(groupSegment(group))}/${encodeURIComponent(plural)}`;
}
