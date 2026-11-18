import {
  matchPath,
  matchRoutes,
  Navigate,
  type Params,
  parsePath,
  type RouteObject,
} from "react-router";
import {
  ArrowRightLeft,
  Blocks,
  CircleArrowUp,
  type IconComponent,
  LayoutDashboard,
  LayoutGrid,
  List,
  Network,
  Package,
  PackagePlus,
  PackageSearch,
  Settings,
  SlidersHorizontal,
  SquareDashed,
} from "../../design/icons";
import { CatalogScreen } from "../../features/catalog/CatalogScreen";
import { ClusterOverview } from "../../features/cluster/ClusterHome";
import { ClusterScreen } from "../../features/cluster/ClusterScreen";
import { HelmChartsRoute } from "../../features/helm/HelmChartsScreen";
import {
  HelmInstallRoute,
  HelmUpgradeRoute,
} from "../../features/helm/HelmFormScreen";
import { HelmReleasesRoute } from "../../features/helm/HelmReleasesScreen";
import { MapRoute } from "../../features/map/MapRoute";
import { PortForwardsRoute } from "../../features/portForward/PortForwardsScreen";
import { PreferencesScreen } from "../../features/prefs/PreferencesScreen";
import { ResourceRoute } from "../../features/resources/ResourceScreen";
import { ClusterSettingsRoute } from "../../features/settings/ClusterSettingsScreen";
import { WorkloadsOverview } from "../../features/workloads/WorkloadsOverview";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import { groupFromSegment, NAV_SECTIONS } from "../../kinds/nav";

/**
 * The locations a tab can hold (spec P6): the children of `/`. A new array each call,
 * because every tab's router gets its own.
 */
export function tabRoutes(): RouteObject[] {
  return [
    { index: true, element: <Navigate to="/catalog" replace /> },
    { path: "catalog", element: <CatalogScreen /> },
    {
      path: "cluster/:id",
      element: <ClusterScreen />,
      children: [
        { index: true, element: <ClusterOverview /> },
        { path: "workloads", element: <WorkloadsOverview /> },
        { path: "r/:group/:plural", element: <ResourceRoute /> },
        { path: "port-forwards", element: <PortForwardsRoute /> },
        { path: "helm/charts", element: <HelmChartsRoute /> },
        { path: "helm/releases", element: <HelmReleasesRoute /> },
        { path: "helm/install", element: <HelmInstallRoute /> },
        {
          path: "helm/upgrade/:namespace/:name",
          element: <HelmUpgradeRoute />,
        },
        { path: "settings", element: <ClusterSettingsRoute /> },
        { path: "map", element: <MapRoute /> },
      ],
    },
    { path: "preferences", element: <PreferencesScreen /> },
  ];
}

const ROUTE_TREE: RouteObject[] = [{ path: "/", children: tabRoutes() }];

/** Whether a path, with or without its query, matches a tab route (spec P39). */
export function isTabRoute(path: string): boolean {
  const { pathname } = parsePath(path);
  if (!pathname?.startsWith("/")) return false;
  return matchRoutes(ROUTE_TREE, pathname) !== null;
}

/** What a tab shows for its location (spec P9). */
export interface TabInfo {
  /** The screen, then the cluster's name on a cluster tab: the tooltip, accessible name and header title. */
  title: string;
  /** The screen's name: the tab's label. */
  screen: string;
  clusterId: string | null;
  /** The catalog name, or "Cluster" while the id is not in the catalog; null off clusters. */
  clusterName: string | null;
  icon: IconComponent;
}

interface Screen {
  pattern: string;
  name: (params: Params) => string;
  icon: IconComponent;
}

const named = (name: string) => () => name;

/** The resource's label in the sidebar, or its plural for a kind the sidebar does not list. */
function resourceLabel(params: Params): string {
  const group = groupFromSegment(params.group ?? "");
  const plural = params.plural ?? "";
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (
        item.type === "resource" &&
        item.group === group &&
        item.plural === plural
      ) {
        return item.label;
      }
    }
  }
  return plural;
}

const SCREENS: readonly Screen[] = [
  { pattern: "/", name: named("Catalog"), icon: LayoutGrid },
  { pattern: "/catalog", name: named("Catalog"), icon: LayoutGrid },
  { pattern: "/preferences", name: named("Preferences"), icon: Settings },
  { pattern: "/cluster/:id", name: named("Overview"), icon: LayoutDashboard },
  { pattern: "/cluster/:id/workloads", name: named("Workloads"), icon: Blocks },
  {
    pattern: "/cluster/:id/r/:group/:plural",
    name: resourceLabel,
    icon: List,
  },
  {
    pattern: "/cluster/:id/port-forwards",
    name: named("Port Forwarding"),
    icon: ArrowRightLeft,
  },
  {
    pattern: "/cluster/:id/helm/charts",
    name: named("Helm charts"),
    icon: PackageSearch,
  },
  {
    pattern: "/cluster/:id/helm/releases",
    name: named("Helm releases"),
    icon: Package,
  },
  {
    pattern: "/cluster/:id/helm/install",
    name: named("Install a chart"),
    icon: PackagePlus,
  },
  {
    pattern: "/cluster/:id/helm/upgrade/:namespace/:name",
    name: (params) => `Upgrade ${params.name ?? ""}`,
    icon: CircleArrowUp,
  },
  {
    pattern: "/cluster/:id/settings",
    name: named("Settings"),
    icon: SlidersHorizontal,
  },
  {
    pattern: "/cluster/:id/map",
    name: named("Resource map"),
    icon: Network,
  },
];

/** Decodes each segment as the router does, keeping an escaped slash inside a segment. */
function decoded(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment).replace(/\//g, "%2F");
      } catch {
        return segment;
      }
    })
    .join("/");
}

/** The cluster a location is on, or null off clusters. */
export function tabCluster(path: string): string | null {
  const pathname = decoded(parsePath(path).pathname ?? "/");
  return (
    matchPath({ path: "/cluster/:id", end: false }, pathname)?.params.id ?? null
  );
}

/** The title, label, cluster and icon of a tab at `path`. */
export function tabInfo(
  path: string,
  clusters: readonly ClusterEntry[],
): TabInfo {
  const pathname = decoded(parsePath(path).pathname ?? "/");
  const clusterId = tabCluster(path);
  let screen = pathname;
  let icon: IconComponent = SquareDashed;
  for (const s of SCREENS) {
    const match = matchPath(s.pattern, pathname);
    if (match) {
      screen = s.name(match.params);
      icon = s.icon;
      break;
    }
  }
  const clusterName =
    clusterId === null
      ? null
      : (clusters.find((c) => c.id === clusterId)?.name ?? "Cluster");
  return {
    title: clusterName === null ? screen : `${screen} · ${clusterName}`,
    screen,
    clusterId,
    clusterName,
    icon,
  };
}
