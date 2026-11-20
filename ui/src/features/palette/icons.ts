import {
  ArrowRightLeft,
  BatchJob,
  Box,
  Boxes,
  CronJob,
  Database,
  Deploy,
  EventStream,
  FileCog,
  HardDrive,
  type IconComponent,
  Ingress,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  LoadBalancer,
  Microchip,
  Namespace,
  Network,
  Package,
  PackageCheck,
  PermissionGroup,
  Pod,
  Puzzle,
  Replica,
  Secret,
  Server,
} from "../../design/icons";

/** The kinds of `resources_names`, by plural. */
export const KIND_ICONS: Partial<Record<string, IconComponent>> = {
  pods: Pod,
  deployments: Deploy,
  statefulsets: Database,
  daemonsets: Layers,
  replicasets: Replica,
  jobs: BatchJob,
  cronjobs: CronJob,
  services: LoadBalancer,
  ingresses: Ingress,
  configmaps: FileCog,
  secrets: Secret,
  persistentvolumeclaims: HardDrive,
  nodes: Server,
  namespaces: Namespace,
};

/** Pages of other kinds take their sidebar section's icon. */
export const SECTION_ICONS: Partial<Record<string, IconComponent>> = {
  nodes: Server,
  workloads: Boxes,
  config: FileCog,
  network: Network,
  storage: HardDrive,
  namespaces: Namespace,
  devices: Microchip,
  events: EventStream,
  helm: Package,
  access: PermissionGroup,
  custom: Puzzle,
};

export const ROUTE_ICONS: Partial<Record<string, IconComponent>> = {
  "port-forwards": ArrowRightLeft,
  "helm/charts": Package,
  "helm/releases": PackageCheck,
  "node-topology": LayoutGrid,
};

export const OVERVIEW_ICON: IconComponent = LayoutDashboard;

/** The cluster's Resource map: the icon of the `resource-map` command. */
export const MAP_ICON: IconComponent = Network;
export const CUSTOM_ICON: IconComponent = Puzzle;
export const FALLBACK_ICON: IconComponent = Box;
