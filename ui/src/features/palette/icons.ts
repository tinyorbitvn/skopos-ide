import {
  ArrowRightLeft,
  Bell,
  Box,
  Boxes,
  CalendarClock,
  Copy,
  Database,
  FileCog,
  Folders,
  Globe,
  HardDrive,
  type IconComponent,
  KeyRound,
  Layers,
  LayoutDashboard,
  Microchip,
  Network,
  Package,
  PackageCheck,
  Puzzle,
  Rocket,
  Server,
  ShieldCheck,
  Waypoints,
  Workflow,
} from "../../design/icons";

/** The kinds of `resources_names`, by plural. */
export const KIND_ICONS: Partial<Record<string, IconComponent>> = {
  pods: Box,
  deployments: Rocket,
  statefulsets: Database,
  daemonsets: Layers,
  replicasets: Copy,
  jobs: Workflow,
  cronjobs: CalendarClock,
  services: Waypoints,
  ingresses: Globe,
  configmaps: FileCog,
  secrets: KeyRound,
  persistentvolumeclaims: HardDrive,
  nodes: Server,
  namespaces: Folders,
};

/** Pages of other kinds take their sidebar section's icon. */
export const SECTION_ICONS: Partial<Record<string, IconComponent>> = {
  nodes: Server,
  workloads: Boxes,
  config: FileCog,
  network: Network,
  storage: HardDrive,
  namespaces: Folders,
  devices: Microchip,
  events: Bell,
  helm: Package,
  access: ShieldCheck,
  custom: Puzzle,
};

export const ROUTE_ICONS: Partial<Record<string, IconComponent>> = {
  "port-forwards": ArrowRightLeft,
  "helm/charts": Package,
  "helm/releases": PackageCheck,
};

export const OVERVIEW_ICON: IconComponent = LayoutDashboard;
export const CUSTOM_ICON: IconComponent = Puzzle;
export const FALLBACK_ICON: IconComponent = Box;
