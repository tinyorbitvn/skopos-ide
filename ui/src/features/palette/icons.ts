import {
  ArrowRightLeft,
  Bell,
  Box,
  Boxes,
  CalendarClock,
  Copy,
  Cpu,
  Database,
  FileCog,
  FolderTree,
  Globe,
  HardDrive,
  type IconComponent,
  KeyRound,
  Layers,
  LayoutDashboard,
  Network,
  Package,
  PackageCheck,
  Puzzle,
  Rocket,
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
  nodes: Cpu,
  namespaces: FolderTree,
};

/** Pages of other kinds take their sidebar section's icon. */
export const SECTION_ICONS: Partial<Record<string, IconComponent>> = {
  nodes: Cpu,
  workloads: Boxes,
  config: FileCog,
  network: Network,
  storage: HardDrive,
  namespaces: FolderTree,
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
