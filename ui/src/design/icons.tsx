/*
 * Every icon of the interface, in one place. Components import icons from here and never
 * from `@thesvg/ui-react` or `lucide-react` (biome.json enforces it).
 *
 * An icon is theSVG UI's fill drawing, from `@thesvg/ui-react`, in the text colour. Each
 * export keeps the name the app has always used. Where theSVG has no drawing of that name,
 * the export draws the closest one, so `Trash2` draws theSVG's trash; `drawing` names it.
 *
 * SVG_ART stays Lucide's: the resource map draws it inside the Kubernetes icons' frame.
 */

import { ActivityFillIcon } from "@thesvg/ui-react/activity";
import { AppWindowFillIcon } from "@thesvg/ui-react/app-window";
import { ArrowLeftFillIcon } from "@thesvg/ui-react/arrow-left";
import { ArrowLeftRightFillIcon } from "@thesvg/ui-react/arrow-left-right";
import { ArrowRightFillIcon } from "@thesvg/ui-react/arrow-right";
import { ArrowUpFillIcon } from "@thesvg/ui-react/arrow-up";
import { ArrowUpDownFillIcon } from "@thesvg/ui-react/arrow-up-down";
import { BatchJobFillIcon } from "@thesvg/ui-react/batch-job";
import { BlockStorageFillIcon } from "@thesvg/ui-react/block-storage";
import { BlocksFillIcon } from "@thesvg/ui-react/blocks";
import { BookOpenFillIcon } from "@thesvg/ui-react/book-open";
import { BoxFillIcon } from "@thesvg/ui-react/box";
import { BoxesFillIcon } from "@thesvg/ui-react/boxes";
import { CalendarClockFillIcon } from "@thesvg/ui-react/calendar-clock";
import { CheckFillIcon } from "@thesvg/ui-react/check";
import { ChevronDownFillIcon } from "@thesvg/ui-react/chevron-down";
import { ChevronLeftFillIcon } from "@thesvg/ui-react/chevron-left";
import { ChevronRightFillIcon } from "@thesvg/ui-react/chevron-right";
import { ChevronUpFillIcon } from "@thesvg/ui-react/chevron-up";
import { ChevronsUpDownFillIcon } from "@thesvg/ui-react/chevrons-up-down";
import { CircleAlertFillIcon } from "@thesvg/ui-react/circle-alert";
import { CircleDashedFillIcon } from "@thesvg/ui-react/circle-dashed";
import { CirclePauseFillIcon } from "@thesvg/ui-react/circle-pause";
import { CirclePlayFillIcon } from "@thesvg/ui-react/circle-play";
import { CirclePlusFillIcon } from "@thesvg/ui-react/circle-plus";
import { CircleQuestionMarkFillIcon } from "@thesvg/ui-react/circle-question-mark";
import { CircleStopFillIcon } from "@thesvg/ui-react/circle-stop";
import { CircleXFillIcon } from "@thesvg/ui-react/circle-x";
import { ClusterFillIcon } from "@thesvg/ui-react/cluster";
import { Columns2FillIcon } from "@thesvg/ui-react/columns-2";
import { CommandFillIcon } from "@thesvg/ui-react/command";
import { ConfigFileFillIcon } from "@thesvg/ui-react/config-file";
import { ContainerFillIcon } from "@thesvg/ui-react/container";
import { CopyFillIcon } from "@thesvg/ui-react/copy";
import { CpuFillIcon } from "@thesvg/ui-react/cpu";
import { CronJobFillIcon } from "@thesvg/ui-react/cron-job";
import { DatabaseFillIcon } from "@thesvg/ui-react/database";
import { DependencyGraphFillIcon } from "@thesvg/ui-react/dependency-graph";
import { DeployFillIcon } from "@thesvg/ui-react/deploy";
import { DockFillIcon } from "@thesvg/ui-react/dock";
import { DownloadFillIcon } from "@thesvg/ui-react/download";
import { DrawerFillIcon } from "@thesvg/ui-react/drawer";
import { EllipsisFillIcon } from "@thesvg/ui-react/ellipsis";
import { EventStreamFillIcon } from "@thesvg/ui-react/event-stream";
import { ExternalLinkFillIcon } from "@thesvg/ui-react/external-link";
import { EyeFillIcon } from "@thesvg/ui-react/eye";
import { EyeOffFillIcon } from "@thesvg/ui-react/eye-off";
import { FileSearchFillIcon } from "@thesvg/ui-react/file-search";
import { FileTextFillIcon } from "@thesvg/ui-react/file-text";
import { FolderFillIcon } from "@thesvg/ui-react/folder";
import { FolderPlusFillIcon } from "@thesvg/ui-react/folder-plus";
import { FolderTreeFillIcon } from "@thesvg/ui-react/folder-tree";
import { FunnelFillIcon } from "@thesvg/ui-react/funnel";
import { GpuFillIcon } from "@thesvg/ui-react/gpu";
import { HelmChartFillIcon } from "@thesvg/ui-react/helm-chart";
import { ImageFillIcon } from "@thesvg/ui-react/image";
import { InfoFillIcon } from "@thesvg/ui-react/info";
import { IngressFillIcon } from "@thesvg/ui-react/ingress";
import { KeyFillIcon } from "@thesvg/ui-react/key";
import { KeyboardFillIcon } from "@thesvg/ui-react/keyboard";
import { LayersFillIcon } from "@thesvg/ui-react/layers";
import { LayoutDashboardFillIcon } from "@thesvg/ui-react/layout-dashboard";
import { LayoutGridFillIcon } from "@thesvg/ui-react/layout-grid";
import { LinkFillIcon } from "@thesvg/ui-react/link";
import { ListFillIcon } from "@thesvg/ui-react/list";
import { LoadBalancerFillIcon } from "@thesvg/ui-react/load-balancer";
import { LogOutFillIcon } from "@thesvg/ui-react/log-out";
import { MapFillIcon } from "@thesvg/ui-react/map";
import { Maximize2FillIcon } from "@thesvg/ui-react/maximize-2";
import { Minimize2FillIcon } from "@thesvg/ui-react/minimize-2";
import { MinusFillIcon } from "@thesvg/ui-react/minus";
import { MonitorFillIcon } from "@thesvg/ui-react/monitor";
import { MoonFillIcon } from "@thesvg/ui-react/moon";
import { NamespaceFillIcon } from "@thesvg/ui-react/namespace";
import { NetworkFillIcon } from "@thesvg/ui-react/network";
import { PackageFillIcon } from "@thesvg/ui-react/package";
import { PenFillIcon } from "@thesvg/ui-react/pen";
import { PermissionGroupFillIcon } from "@thesvg/ui-react/permission-group";
import { PinFillIcon } from "@thesvg/ui-react/pin";
import { PlayFillIcon } from "@thesvg/ui-react/play";
import { PlugFillIcon } from "@thesvg/ui-react/plug";
import { PlusFillIcon } from "@thesvg/ui-react/plus";
import { PodFillIcon } from "@thesvg/ui-react/pod";
import { PowerFillIcon } from "@thesvg/ui-react/power";
import { PuzzleFillIcon } from "@thesvg/ui-react/puzzle";
import { RefreshCwFillIcon } from "@thesvg/ui-react/refresh-cw";
import { RegistryFillIcon } from "@thesvg/ui-react/registry";
import { ReplicaFillIcon } from "@thesvg/ui-react/replica";
import { RollbackFillIcon } from "@thesvg/ui-react/rollback";
import { RotateCcwFillIcon } from "@thesvg/ui-react/rotate-ccw";
import { RotateCwFillIcon } from "@thesvg/ui-react/rotate-cw";
import { ScanFillIcon } from "@thesvg/ui-react/scan";
import { ScrollTextFillIcon } from "@thesvg/ui-react/scroll-text";
import { SearchFillIcon } from "@thesvg/ui-react/search";
import { SecretFillIcon } from "@thesvg/ui-react/secret";
import { ServerFillIcon } from "@thesvg/ui-react/server";
import { SettingsFillIcon } from "@thesvg/ui-react/settings";
import { ShieldCheckFillIcon } from "@thesvg/ui-react/shield-check";
import { ShieldOffFillIcon } from "@thesvg/ui-react/shield-off";
import { SlidersHorizontalFillIcon } from "@thesvg/ui-react/sliders-horizontal";
import { SplitFillIcon } from "@thesvg/ui-react/split";
import { SquareFillIcon } from "@thesvg/ui-react/square";
import { StarFillIcon } from "@thesvg/ui-react/star";
import { SunFillIcon } from "@thesvg/ui-react/sun";
import { TagsFillIcon } from "@thesvg/ui-react/tags";
import { TargetFillIcon } from "@thesvg/ui-react/target";
import { TerminalFillIcon } from "@thesvg/ui-react/terminal";
import { TerminalPromptFillIcon } from "@thesvg/ui-react/terminal-prompt";
import { TrashFillIcon } from "@thesvg/ui-react/trash";
import { TriangleAlertFillIcon } from "@thesvg/ui-react/triangle-alert";
import { UnplugFillIcon } from "@thesvg/ui-react/unplug";
import { UploadFillIcon } from "@thesvg/ui-react/upload";
import { XFillIcon } from "@thesvg/ui-react/x";
import { ZapFillIcon } from "@thesvg/ui-react/zap";
import {
  DoorOpen as LucideDoorOpen,
  type LucideIcon,
  Layers as LucideLayers,
  Route as LucideRoute,
  Split as LucideSplit,
} from "lucide-react";
import type { ComponentType, CSSProperties, ReactElement } from "react";
import styles from "./icons.module.css";

/** One of theSVG UI's drawings, as `@thesvg/ui-react` exports it. */
type Drawing = ComponentType<{ size?: number; "aria-hidden"?: "true" }>;

export interface IconProps {
  /** Width and height in pixels; 24 when left out. */
  size?: number;
  /** Classes for the icon's box, a span around its svg. */
  className?: string;
  style?: CSSProperties;
  /** Hidden from assistive technology unless it has a label. */
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
  role?: string;
  "data-testid"?: string;
}

/** An icon of this module: a component, with its name and the drawing it shows. */
export interface IconComponent {
  (props: IconProps): ReactElement;
  displayName?: string;
  /** The icon's kebab-case name, its export's, such as `trash-2`. */
  readonly iconName: string;
  /** theSVG UI's name of the drawing it shows, such as `trash`. */
  readonly drawing: string;
}

function boxProps(
  name: string,
  { className, ...rest }: Omit<IconProps, "size">,
) {
  const labelled = rest["aria-label"] !== undefined;
  return {
    ...rest,
    "aria-hidden": rest["aria-hidden"] ?? (labelled ? undefined : true),
    className: [styles.icon, className].filter(Boolean).join(" "),
    "data-icon": name,
  };
}

/**
 * theSVG's drawing `drawing`, in a box named `name` that carries the caller's class, style
 * and label. Each copy of the drawing gets its own mask ids.
 */
function icon(name: string, drawing: string, Drawing: Drawing): IconComponent {
  function Icon({ size = 24, ...rest }: IconProps): ReactElement {
    return (
      <span {...boxProps(name, rest)}>
        <Drawing size={size} aria-hidden="true" />
      </span>
    );
  }
  const pascal = name.replace(/(^|-)(\w)/g, (_, _dash, c: string) =>
    c.toUpperCase(),
  );
  return Object.assign(Icon, {
    displayName: `Icon(${pascal})`,
    iconName: name,
    drawing,
  });
}

/**
 * Lucide's drawings for use inside another SVG, such as a kind's frame on the resource map,
 * where the box an icon of this module brings cannot go.
 */
export const SVG_ART = {
  DoorOpen: LucideDoorOpen,
  Layers: LucideLayers,
  Route: LucideRoute,
  Split: LucideSplit,
} as const;

/** One of `SVG_ART`'s drawings. */
export type SvgArt = LucideIcon;

export const Activity = /* @__PURE__ */ icon(
  "activity",
  "activity",
  ActivityFillIcon,
);
export const AppWindow = /* @__PURE__ */ icon(
  "app-window",
  "app-window",
  AppWindowFillIcon,
);
export const ArrowDownToLine = /* @__PURE__ */ icon(
  "arrow-down-to-line",
  "download",
  DownloadFillIcon,
);
export const ArrowLeft = /* @__PURE__ */ icon(
  "arrow-left",
  "arrow-left",
  ArrowLeftFillIcon,
);
export const ArrowRight = /* @__PURE__ */ icon(
  "arrow-right",
  "arrow-right",
  ArrowRightFillIcon,
);
export const ArrowRightLeft = /* @__PURE__ */ icon(
  "arrow-right-left",
  "arrow-left-right",
  ArrowLeftRightFillIcon,
);
export const BatchJob = /* @__PURE__ */ icon(
  "batch-job",
  "batch-job",
  BatchJobFillIcon,
);
export const Blocks = /* @__PURE__ */ icon("blocks", "blocks", BlocksFillIcon);
export const BookOpen = /* @__PURE__ */ icon(
  "book-open",
  "book-open",
  BookOpenFillIcon,
);
export const Box = /* @__PURE__ */ icon("box", "box", BoxFillIcon);
export const Boxes = /* @__PURE__ */ icon("boxes", "boxes", BoxesFillIcon);
export const CalendarClock = /* @__PURE__ */ icon(
  "calendar-clock",
  "calendar-clock",
  CalendarClockFillIcon,
);
export const Check = /* @__PURE__ */ icon("check", "check", CheckFillIcon);
export const ChevronDown = /* @__PURE__ */ icon(
  "chevron-down",
  "chevron-down",
  ChevronDownFillIcon,
);
export const ChevronLeft = /* @__PURE__ */ icon(
  "chevron-left",
  "chevron-left",
  ChevronLeftFillIcon,
);
export const ChevronRight = /* @__PURE__ */ icon(
  "chevron-right",
  "chevron-right",
  ChevronRightFillIcon,
);
export const ChevronUp = /* @__PURE__ */ icon(
  "chevron-up",
  "chevron-up",
  ChevronUpFillIcon,
);
export const ChevronsUpDown = /* @__PURE__ */ icon(
  "chevrons-up-down",
  "chevrons-up-down",
  ChevronsUpDownFillIcon,
);
export const CircleAlert = /* @__PURE__ */ icon(
  "circle-alert",
  "circle-alert",
  CircleAlertFillIcon,
);
export const CircleArrowUp = /* @__PURE__ */ icon(
  "circle-arrow-up",
  "arrow-up",
  ArrowUpFillIcon,
);
export const CircleHelp = /* @__PURE__ */ icon(
  "circle-question-mark",
  "circle-question-mark",
  CircleQuestionMarkFillIcon,
);
export const CirclePause = /* @__PURE__ */ icon(
  "circle-pause",
  "circle-pause",
  CirclePauseFillIcon,
);
export const CirclePlay = /* @__PURE__ */ icon(
  "circle-play",
  "circle-play",
  CirclePlayFillIcon,
);
export const CircleStop = /* @__PURE__ */ icon(
  "circle-stop",
  "circle-stop",
  CircleStopFillIcon,
);
export const CircleX = /* @__PURE__ */ icon(
  "circle-x",
  "circle-x",
  CircleXFillIcon,
);

export const Cluster = /* @__PURE__ */ icon(
  "cluster",
  "cluster",
  ClusterFillIcon,
);
export const Columns2 = /* @__PURE__ */ icon(
  "columns-2",
  "columns-2",
  Columns2FillIcon,
);
export const Columns3 = /* @__PURE__ */ icon(
  "columns-3",
  "columns-2",
  Columns2FillIcon,
);
export const Command = /* @__PURE__ */ icon(
  "command",
  "command",
  CommandFillIcon,
);
export const Container = /* @__PURE__ */ icon(
  "container",
  "container",
  ContainerFillIcon,
);
export const Copy = /* @__PURE__ */ icon("copy", "copy", CopyFillIcon);
export const CornerLeftUp = /* @__PURE__ */ icon(
  "corner-left-up",
  "arrow-up",
  ArrowUpFillIcon,
);
export const Cpu = /* @__PURE__ */ icon("cpu", "cpu", CpuFillIcon);
export const CronJob = /* @__PURE__ */ icon(
  "cron-job",
  "cron-job",
  CronJobFillIcon,
);
export const Database = /* @__PURE__ */ icon(
  "database",
  "database",
  DatabaseFillIcon,
);
export const DependencyGraph = /* @__PURE__ */ icon(
  "dependency-graph",
  "dependency-graph",
  DependencyGraphFillIcon,
);
export const Deploy = /* @__PURE__ */ icon("deploy", "deploy", DeployFillIcon);
export const Download = /* @__PURE__ */ icon(
  "download",
  "download",
  DownloadFillIcon,
);
export const Ellipsis = /* @__PURE__ */ icon(
  "ellipsis",
  "ellipsis",
  EllipsisFillIcon,
);
export const EventStream = /* @__PURE__ */ icon(
  "event-stream",
  "event-stream",
  EventStreamFillIcon,
);
export const ExternalLink = /* @__PURE__ */ icon(
  "external-link",
  "external-link",
  ExternalLinkFillIcon,
);
export const Eye = /* @__PURE__ */ icon("eye", "eye", EyeFillIcon);
export const EyeOff = /* @__PURE__ */ icon(
  "eye-off",
  "eye-off",
  EyeOffFillIcon,
);
export const FileCog = /* @__PURE__ */ icon(
  "file-cog",
  "config-file",
  ConfigFileFillIcon,
);
export const FilePlus = /* @__PURE__ */ icon(
  "file-plus",
  "circle-plus",
  CirclePlusFillIcon,
);
export const FileSearch = /* @__PURE__ */ icon(
  "file-search",
  "file-search",
  FileSearchFillIcon,
);
export const FileText = /* @__PURE__ */ icon(
  "file-text",
  "file-text",
  FileTextFillIcon,
);
export const Folder = /* @__PURE__ */ icon("folder", "folder", FolderFillIcon);
export const FolderPlus = /* @__PURE__ */ icon(
  "folder-plus",
  "folder-plus",
  FolderPlusFillIcon,
);
export const FolderTree = /* @__PURE__ */ icon(
  "folder-tree",
  "folder-tree",
  FolderTreeFillIcon,
);
export const FunnelX = /* @__PURE__ */ icon(
  "funnel-x",
  "funnel",
  FunnelFillIcon,
);
export const HardDrive = /* @__PURE__ */ icon(
  "hard-drive",
  "block-storage",
  BlockStorageFillIcon,
);
export const History = /* @__PURE__ */ icon(
  "history",
  "rollback",
  RollbackFillIcon,
);
export const ImageIcon = /* @__PURE__ */ icon("image", "image", ImageFillIcon);
export const ImageUp = /* @__PURE__ */ icon(
  "image-up",
  "upload",
  UploadFillIcon,
);
export const Info = /* @__PURE__ */ icon("info", "info", InfoFillIcon);
export const Ingress = /* @__PURE__ */ icon(
  "ingress",
  "ingress",
  IngressFillIcon,
);
export const KeyRound = /* @__PURE__ */ icon("key-round", "key", KeyFillIcon);
export const Keyboard = /* @__PURE__ */ icon(
  "keyboard",
  "keyboard",
  KeyboardFillIcon,
);
export const Layers = /* @__PURE__ */ icon("layers", "layers", LayersFillIcon);
export const LayoutDashboard = /* @__PURE__ */ icon(
  "layout-dashboard",
  "layout-dashboard",
  LayoutDashboardFillIcon,
);
export const LayoutGrid = /* @__PURE__ */ icon(
  "layout-grid",
  "layout-grid",
  LayoutGridFillIcon,
);
export const Library = /* @__PURE__ */ icon(
  "library",
  "registry",
  RegistryFillIcon,
);
export const Link = /* @__PURE__ */ icon("link", "link", LinkFillIcon);
export const List = /* @__PURE__ */ icon("list", "list", ListFillIcon);
export const ListTree = /* @__PURE__ */ icon(
  "list-tree",
  "folder-tree",
  FolderTreeFillIcon,
);
export const LoadBalancer = /* @__PURE__ */ icon(
  "load-balancer",
  "load-balancer",
  LoadBalancerFillIcon,
);
export const LogOut = /* @__PURE__ */ icon(
  "log-out",
  "log-out",
  LogOutFillIcon,
);

/** Named so that it does not shadow the global `Map`. */
export const MapIcon = /* @__PURE__ */ icon("map", "map", MapFillIcon);
export const Maximize2 = /* @__PURE__ */ icon(
  "maximize-2",
  "maximize-2",
  Maximize2FillIcon,
);
export const Microchip = /* @__PURE__ */ icon("microchip", "gpu", GpuFillIcon);
export const Minimize2 = /* @__PURE__ */ icon(
  "minimize-2",
  "minimize-2",
  Minimize2FillIcon,
);
export const Monitor = /* @__PURE__ */ icon(
  "monitor",
  "monitor",
  MonitorFillIcon,
);
export const Moon = /* @__PURE__ */ icon("moon", "moon", MoonFillIcon);
export const MoveVertical = /* @__PURE__ */ icon(
  "move-vertical",
  "arrow-up-down",
  ArrowUpDownFillIcon,
);
export const Namespace = /* @__PURE__ */ icon(
  "namespace",
  "namespace",
  NamespaceFillIcon,
);
export const Network = /* @__PURE__ */ icon(
  "network",
  "network",
  NetworkFillIcon,
);
export const Package = /* @__PURE__ */ icon(
  "package",
  "package",
  PackageFillIcon,
);
export const PackageCheck = /* @__PURE__ */ icon(
  "package-check",
  "package",
  PackageFillIcon,
);
export const PackagePlus = /* @__PURE__ */ icon(
  "package-plus",
  "deploy",
  DeployFillIcon,
);
export const PackageSearch = /* @__PURE__ */ icon(
  "package-search",
  "helm-chart",
  HelmChartFillIcon,
);
export const PanelBottom = /* @__PURE__ */ icon(
  "panel-bottom",
  "dock",
  DockFillIcon,
);
export const PanelRightOpen = /* @__PURE__ */ icon(
  "panel-right-open",
  "drawer",
  DrawerFillIcon,
);
export const Pen = /* @__PURE__ */ icon("pen", "pen", PenFillIcon);
export const PermissionGroup = /* @__PURE__ */ icon(
  "permission-group",
  "permission-group",
  PermissionGroupFillIcon,
);
export const Pin = /* @__PURE__ */ icon("pin", "pin", PinFillIcon);
export const Play = /* @__PURE__ */ icon("play", "play", PlayFillIcon);
export const Plug = /* @__PURE__ */ icon("plug", "plug", PlugFillIcon);
export const Plus = /* @__PURE__ */ icon("plus", "plus", PlusFillIcon);
export const Pod = /* @__PURE__ */ icon("pod", "pod", PodFillIcon);
export const Power = /* @__PURE__ */ icon("power", "power", PowerFillIcon);
export const Puzzle = /* @__PURE__ */ icon("puzzle", "puzzle", PuzzleFillIcon);
export const RefreshCw = /* @__PURE__ */ icon(
  "refresh-cw",
  "refresh-cw",
  RefreshCwFillIcon,
);
export const Replica = /* @__PURE__ */ icon(
  "replica",
  "replica",
  ReplicaFillIcon,
);
export const RotateCcw = /* @__PURE__ */ icon(
  "rotate-ccw",
  "rotate-ccw",
  RotateCcwFillIcon,
);
export const RotateCw = /* @__PURE__ */ icon(
  "rotate-cw",
  "rotate-cw",
  RotateCwFillIcon,
);
export const Scan = /* @__PURE__ */ icon("scan", "scan", ScanFillIcon);
export const ScrollText = /* @__PURE__ */ icon(
  "scroll-text",
  "scroll-text",
  ScrollTextFillIcon,
);
export const Search = /* @__PURE__ */ icon("search", "search", SearchFillIcon);
export const Secret = /* @__PURE__ */ icon("secret", "secret", SecretFillIcon);
export const Server = /* @__PURE__ */ icon("server", "server", ServerFillIcon);
export const Settings = /* @__PURE__ */ icon(
  "settings",
  "settings",
  SettingsFillIcon,
);
export const ShieldCheck = /* @__PURE__ */ icon(
  "shield-check",
  "shield-check",
  ShieldCheckFillIcon,
);
export const ShieldOff = /* @__PURE__ */ icon(
  "shield-off",
  "shield-off",
  ShieldOffFillIcon,
);
export const SlidersHorizontal = /* @__PURE__ */ icon(
  "sliders-horizontal",
  "sliders-horizontal",
  SlidersHorizontalFillIcon,
);
export const Split = /* @__PURE__ */ icon("split", "split", SplitFillIcon);
export const Square = /* @__PURE__ */ icon("square", "square", SquareFillIcon);
export const SquareDashed = /* @__PURE__ */ icon(
  "square-dashed",
  "circle-dashed",
  CircleDashedFillIcon,
);
export const SquareTerminal = /* @__PURE__ */ icon(
  "square-terminal",
  "terminal-prompt",
  TerminalPromptFillIcon,
);
export const Star = /* @__PURE__ */ icon("star", "star", StarFillIcon);
export const Sun = /* @__PURE__ */ icon("sun", "sun", SunFillIcon);
export const Tags = /* @__PURE__ */ icon("tags", "tags", TagsFillIcon);

export const Target = /* @__PURE__ */ icon("target", "target", TargetFillIcon);
export const Terminal = /* @__PURE__ */ icon(
  "terminal",
  "terminal",
  TerminalFillIcon,
);
export const Trash2 = /* @__PURE__ */ icon("trash-2", "trash", TrashFillIcon);
export const TriangleAlert = /* @__PURE__ */ icon(
  "triangle-alert",
  "triangle-alert",
  TriangleAlertFillIcon,
);
export const Unplug = /* @__PURE__ */ icon("unplug", "unplug", UnplugFillIcon);
export const X = /* @__PURE__ */ icon("x", "x", XFillIcon);
export const Zap = /* @__PURE__ */ icon("zap", "zap", ZapFillIcon);
export const ZoomIn = /* @__PURE__ */ icon("zoom-in", "plus", PlusFillIcon);
export const ZoomOut = /* @__PURE__ */ icon("zoom-out", "minus", MinusFillIcon);
