import type { IconComponent } from "../design/icons";
import {
  FALLBACK_ICON,
  MAP_ICON,
  OVERVIEW_ICON,
  SECTION_ICONS,
} from "../features/palette/icons";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";

export interface NavResource {
  type: "resource";
  label: string;
  /** The sidebar's text where it differs from the kind's label: the Nodes and Namespaces lists read "List". */
  sidebarLabel?: string;
  /** The API group; "" is the core group. */
  group: string;
  plural: string;
}

/** A screen of the cluster that is not a resource list, at `/cluster/:id/<path>`. */
export interface NavRoute {
  type: "route";
  label: string;
  path: string;
  /** The `group/plural` the cluster must list for the route to show: Topology needs `/nodes`. */
  requires?: string;
}

export type NavItem = NavResource | NavRoute;

/** A key for an item, unique in the sidebar. */
export function navItemKey(item: NavItem): string {
  return item.type === "route"
    ? `route:${item.path}`
    : `${item.group}/${item.plural}`;
}

/** An item's text in the sidebar and in its rail flyout. */
export function navLabel(item: NavItem): string {
  return item.type === "resource"
    ? (item.sidebarLabel ?? item.label)
    : item.label;
}

/** The sidebar's groups, in order (spec Q §2). The first one has no label. */
export type NavGroupId = "top" | "apps" | "cluster" | "resources";

export interface NavGroup {
  id: NavGroupId;
  label: string | null;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "top", label: null },
  { id: "apps", label: "Apps" },
  { id: "cluster", label: "Cluster" },
  { id: "resources", label: "Resources" },
];

/** A project logo that stands for a section in place of an icon. */
export type NavLogo = "helm" | "argo";
export type NavIcon = IconComponent | NavLogo;

/** A sub-branch of a section, such as Argo's "Argo CD": some of the section's items. */
export interface NavBranch {
  id: string;
  label: string;
  items: NavResource[];
}

export interface NavSection {
  id: string;
  label: string;
  group: Exclude<NavGroupId, "top">;
  icon: NavIcon;
  /** A section with one screen: the sidebar shows it as a direct link to that item. */
  direct?: boolean;
  /** A first "Overview" entry that links to `/cluster/:id/<overview>`. */
  overview?: string;
  items: NavItem[];
  /** Sub-branches. Each lists some of `items`, which then show under it. */
  branches?: NavBranch[];
}

/** A screen of the first group, at `/cluster/:id/<path>`; "" is the cluster's home. */
export interface NavScreen {
  id: "overview" | "map";
  label: string;
  path: string;
  icon: IconComponent;
}

export const NAV_SCREENS: readonly NavScreen[] = [
  { id: "overview", label: "Overview", path: "", icon: OVERVIEW_ICON },
  { id: "map", label: "Resource map", path: "map", icon: MAP_ICON },
];

/** The icon the app already picks for a section (`features/palette/icons.ts`). */
function glyph(id: string): IconComponent {
  return SECTION_ICONS[id] ?? FALLBACK_ICON;
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

/** The Argo CD kinds: the items of the Argo section and of its Argo CD branch. */
const ARGO_CD: NavResource[] = [
  r("Applications", ARGO, "applications"),
  r("ApplicationSets", ARGO, "applicationsets"),
  r("AppProjects", ARGO, "appprojects"),
];

/**
 * The sidebar sections of F4, in their groups and in order (spec Q §2): Apps (Helm,
 * Argo), Cluster (Nodes, Namespaces, Events), then Resources. Events is a direct link.
 * Nodes holds its list, which the sidebar calls List, and the Topology page, which shows
 * only where nodes can be listed; Namespaces holds its list, also called List. Argo holds
 * the Argo CD kinds in its "Argo CD" branch (spec G §3). Nodes, Namespaces, Workloads,
 * Network and Storage start with an Overview entry that links to their section overview
 * (F17, section overviews spec §3.7), which shows while the section does. Port
 * Forwarding and Helm's Charts and Releases are routes of the cluster screen, not
 * resource kinds. Custom Resources starts with Definitions; the entries for each CRD are
 * added by `customResourceGroups`. The Gateway API kinds are under Network, where
 * `visibleSections` adds the other served kinds of `GATEWAY_GROUPS` (spec M2, M3), and
 * the Dynamic Resource Allocation kinds have their own section (Device Resources); items
 * hide where the cluster does not serve them.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "helm",
    label: "Helm",
    group: "apps",
    icon: "helm",
    items: [
      { type: "route", label: "Charts", path: "helm/charts" },
      { type: "route", label: "Releases", path: "helm/releases" },
    ],
  },
  {
    id: "argo",
    label: "Argo",
    group: "apps",
    icon: "argo",
    items: ARGO_CD,
    branches: [{ id: "argocd", label: "Argo CD", items: ARGO_CD }],
  },
  {
    id: "nodes",
    label: "Nodes",
    group: "cluster",
    icon: glyph("nodes"),
    overview: "nodes",
    items: [
      { ...r("Nodes", "", "nodes"), sidebarLabel: "List" },
      {
        type: "route",
        label: "Topology",
        path: "node-topology",
        requires: "/nodes",
      },
    ],
  },
  {
    id: "namespaces",
    label: "Namespaces",
    group: "cluster",
    icon: glyph("namespaces"),
    overview: "namespaces",
    items: [{ ...r("Namespaces", "", "namespaces"), sidebarLabel: "List" }],
  },
  {
    id: "events",
    label: "Events",
    group: "cluster",
    icon: glyph("events"),
    direct: true,
    items: [r("Events", "", "events")],
  },
  {
    id: "workloads",
    label: "Workloads",
    group: "resources",
    icon: glyph("workloads"),
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
    group: "resources",
    icon: glyph("config"),
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
    group: "resources",
    icon: glyph("network"),
    overview: "network",
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
    group: "resources",
    icon: glyph("storage"),
    overview: "storage",
    items: [
      r("PersistentVolumeClaims", "", "persistentvolumeclaims"),
      r("PersistentVolumes", "", "persistentvolumes"),
      r("StorageClasses", "storage.k8s.io", "storageclasses"),
    ],
  },
  {
    id: "access",
    label: "Access Control",
    group: "resources",
    icon: glyph("access"),
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
    id: "devices",
    label: "Device Resources",
    group: "resources",
    icon: glyph("devices"),
    items: [
      r("ResourceClaims", RESOURCE, "resourceclaims"),
      r("ResourceClaimTemplates", RESOURCE, "resourceclaimtemplates"),
      r("DeviceClasses", RESOURCE, "deviceclasses"),
      r("ResourceSlices", RESOURCE, "resourceslices"),
    ],
  },
  {
    id: "custom",
    label: "Custom Resources",
    group: "resources",
    icon: glyph("custom"),
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
 * Removes the items that are not served or not listable, then empty sections and empty
 * branches. Network also gets the other served Gateway API kinds, just before Port
 * Forwarding.
 */
export function visibleSections(resources: ApiResourceInfo[]): NavSection[] {
  const ok = listable(resources);
  // A route needs no resource to list, unless it names the one it requires.
  const shows = (i: NavItem) =>
    i.type === "route"
      ? i.requires === undefined || ok.has(i.requires)
      : ok.has(`${i.group}/${i.plural}`);
  const gateway = otherGatewayItems(resources);
  return NAV_SECTIONS.map((section) => {
    let items = section.items.filter(shows);
    if (section.id === "network" && gateway.length > 0) {
      const route = items.findIndex((i) => i.type === "route");
      const at = route === -1 ? items.length : route;
      items = [...items.slice(0, at), ...gateway, ...items.slice(at)];
    }
    if (section.branches === undefined) return { ...section, items };
    const branches = section.branches
      .map((b) => ({ ...b, items: b.items.filter(shows) }))
      .filter((b) => b.items.length > 0);
    return { ...section, items, branches };
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
