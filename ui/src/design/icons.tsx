/*
 * Every icon of the interface, in one place. Components import icons from here and never
 * from `@animateicons/react` or `lucide-react` (biome.json enforces it).
 *
 * An icon is Lucide's drawing, animated by `@animateicons/react` when that package has it,
 * and played while the control that holds it is hovered or has keyboard focus (see
 * iconTrigger.ts). The few icons the package lacks stay Lucide's still drawing. Each export
 * keeps its lucide-react name, so `Trash2` here is Lucide's trash-2. Each icon is imported
 * from its own file of the package, so only the icons listed here ship.
 */

import { ActivityIcon } from "@animateicons/react/lucide/activity-icon";
import { AppWindowIcon } from "@animateicons/react/lucide/app-window-icon";
import { ArrowDownToLineIcon } from "@animateicons/react/lucide/arrow-down-to-line-icon";
import { ArrowLeftIcon } from "@animateicons/react/lucide/arrow-left-icon";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import { ArrowRightLeftIcon } from "@animateicons/react/lucide/arrow-right-left-icon";
import { BellIcon } from "@animateicons/react/lucide/bell-icon";
import { BlocksIcon } from "@animateicons/react/lucide/blocks-icon";
import { BookOpenIcon } from "@animateicons/react/lucide/book-open-icon";
import { BoxIcon } from "@animateicons/react/lucide/box-icon";
import { BoxesIcon } from "@animateicons/react/lucide/boxes-icon";
import { CalendarClockIcon } from "@animateicons/react/lucide/calendar-clock-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import { ChevronLeftIcon } from "@animateicons/react/lucide/chevron-left-icon";
import { ChevronRightIcon } from "@animateicons/react/lucide/chevron-right-icon";
import { ChevronUpIcon } from "@animateicons/react/lucide/chevron-up-icon";
import { ChevronsUpDownIcon } from "@animateicons/react/lucide/chevrons-up-down-icon";
import { CircleAlertIcon } from "@animateicons/react/lucide/circle-alert-icon";
import { CircleArrowUpIcon } from "@animateicons/react/lucide/circle-arrow-up-icon";
import { CirclePauseIcon } from "@animateicons/react/lucide/circle-pause-icon";
import { CirclePlayIcon } from "@animateicons/react/lucide/circle-play-icon";
import { CircleQuestionMarkIcon } from "@animateicons/react/lucide/circle-question-mark-icon";
import { CircleStopIcon } from "@animateicons/react/lucide/circle-stop-icon";
import { CircleXIcon } from "@animateicons/react/lucide/circle-x-icon";
import { Columns2Icon } from "@animateicons/react/lucide/columns-2-icon";
import { Columns3Icon } from "@animateicons/react/lucide/columns-3-icon";
import { CommandIcon } from "@animateicons/react/lucide/command-icon";
import { CopyIcon } from "@animateicons/react/lucide/copy-icon";
import { CornerLeftUpIcon } from "@animateicons/react/lucide/corner-left-up-icon";
import { CpuIcon } from "@animateicons/react/lucide/cpu-icon";
import { DatabaseIcon } from "@animateicons/react/lucide/database-icon";
import { DownloadIcon } from "@animateicons/react/lucide/download-icon";
import { EllipsisIcon } from "@animateicons/react/lucide/ellipsis-icon";
import { ExternalLinkIcon } from "@animateicons/react/lucide/external-link-icon";
import { EyeIcon } from "@animateicons/react/lucide/eye-icon";
import { EyeOffIcon } from "@animateicons/react/lucide/eye-off-icon";
import { FilePlusIcon } from "@animateicons/react/lucide/file-plus-icon";
import { FileSearchIcon } from "@animateicons/react/lucide/file-search-icon";
import { FileTextIcon } from "@animateicons/react/lucide/file-text-icon";
import { FolderIcon } from "@animateicons/react/lucide/folder-icon";
import { FolderPlusIcon } from "@animateicons/react/lucide/folder-plus-icon";
import { FolderTreeIcon } from "@animateicons/react/lucide/folder-tree-icon";
import { FunnelXIcon } from "@animateicons/react/lucide/funnel-x-icon";
import { GlobeIcon } from "@animateicons/react/lucide/globe-icon";
import { HardDriveIcon } from "@animateicons/react/lucide/hard-drive-icon";
import { HistoryIcon } from "@animateicons/react/lucide/history-icon";
import { ImageIcon as AnimatedImageIcon } from "@animateicons/react/lucide/image-icon";
import { InfoIcon } from "@animateicons/react/lucide/info-icon";
import { KeyRoundIcon } from "@animateicons/react/lucide/key-round-icon";
import { KeyboardIcon } from "@animateicons/react/lucide/keyboard-icon";
import { LayersIcon } from "@animateicons/react/lucide/layers-icon";
import { LayoutDashboardIcon } from "@animateicons/react/lucide/layout-dashboard-icon";
import { LayoutGridIcon } from "@animateicons/react/lucide/layout-grid-icon";
import { LinkIcon } from "@animateicons/react/lucide/link-icon";
import { ListIcon } from "@animateicons/react/lucide/list-icon";
import { ListTreeIcon } from "@animateicons/react/lucide/list-tree-icon";
import { LogOutIcon } from "@animateicons/react/lucide/log-out-icon";
import { Maximize2Icon } from "@animateicons/react/lucide/maximize-2-icon";
import { Minimize2Icon } from "@animateicons/react/lucide/minimize-2-icon";
import { MonitorIcon } from "@animateicons/react/lucide/monitor-icon";
import { MoonIcon } from "@animateicons/react/lucide/moon-icon";
import { MoveVerticalIcon } from "@animateicons/react/lucide/move-vertical-icon";
import { NetworkIcon } from "@animateicons/react/lucide/network-icon";
import { PackageCheckIcon } from "@animateicons/react/lucide/package-check-icon";
import { PackageIcon } from "@animateicons/react/lucide/package-icon";
import { PackagePlusIcon } from "@animateicons/react/lucide/package-plus-icon";
import { PackageSearchIcon } from "@animateicons/react/lucide/package-search-icon";
import { PanelBottomIcon } from "@animateicons/react/lucide/panel-bottom-icon";
import { PanelRightOpenIcon } from "@animateicons/react/lucide/panel-right-open-icon";
import { PinIcon } from "@animateicons/react/lucide/pin-icon";
import { PlayIcon } from "@animateicons/react/lucide/play-icon";
import { PlugIcon } from "@animateicons/react/lucide/plug-icon";
import { PlusIcon } from "@animateicons/react/lucide/plus-icon";
import { PowerIcon } from "@animateicons/react/lucide/power-icon";
import { PuzzleIcon } from "@animateicons/react/lucide/puzzle-icon";
import { RefreshCwIcon } from "@animateicons/react/lucide/refresh-cw-icon";
import { RocketIcon } from "@animateicons/react/lucide/rocket-icon";
import { RotateCcwIcon } from "@animateicons/react/lucide/rotate-ccw-icon";
import { RotateCwIcon } from "@animateicons/react/lucide/rotate-cw-icon";
import { ScanIcon } from "@animateicons/react/lucide/scan-icon";
import { ScrollTextIcon } from "@animateicons/react/lucide/scroll-text-icon";
import { SearchIcon } from "@animateicons/react/lucide/search-icon";
import { ServerIcon } from "@animateicons/react/lucide/server-icon";
import { SettingsIcon } from "@animateicons/react/lucide/settings-icon";
import { ShieldCheckIcon } from "@animateicons/react/lucide/shield-check-icon";
import { ShieldOffIcon } from "@animateicons/react/lucide/shield-off-icon";
import { SlidersHorizontalIcon } from "@animateicons/react/lucide/sliders-horizontal-icon";
import { SquareDashedIcon } from "@animateicons/react/lucide/square-dashed-icon";
import { SquareIcon } from "@animateicons/react/lucide/square-icon";
import { SquareTerminalIcon } from "@animateicons/react/lucide/square-terminal-icon";
import { StarIcon } from "@animateicons/react/lucide/star-icon";
import { SunIcon } from "@animateicons/react/lucide/sun-icon";
import { TagsIcon } from "@animateicons/react/lucide/tags-icon";
import { TerminalIcon } from "@animateicons/react/lucide/terminal-icon";
import { Trash2Icon } from "@animateicons/react/lucide/trash-2-icon";
import { TriangleAlertIcon } from "@animateicons/react/lucide/triangle-alert-icon";
import { WaypointsIcon } from "@animateicons/react/lucide/waypoints-icon";
import { WorkflowIcon } from "@animateicons/react/lucide/workflow-icon";
import { XIcon } from "@animateicons/react/lucide/x-icon";
import { ZapIcon } from "@animateicons/react/lucide/zap-icon";
import { ZoomInIcon } from "@animateicons/react/lucide/zoom-in-icon";
import { ZoomOutIcon } from "@animateicons/react/lucide/zoom-out-icon";
import {
  DoorOpen,
  Container as LucideContainer,
  FileCog as LucideFileCog,
  type LucideIcon,
  ImageUp as LucideImageUp,
  Layers as LucideLayers,
  Library as LucideLibrary,
  Pen as LucidePen,
  Split as LucideSplit,
  Unplug as LucideUnplug,
  Route,
} from "lucide-react";
import {
  type CSSProperties,
  type ForwardRefExoticComponent,
  type ReactElement,
  type RefAttributes,
  useEffect,
  useRef,
} from "react";
import styles from "./icons.module.css";
import { bindToControl, type IconAnimation } from "./iconTrigger";

export interface IconProps {
  /** Width and height in pixels; 24 when left out, as in Lucide. */
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

/** An icon of this module: a component, with the name of the drawing it shows. */
export interface IconComponent {
  (props: IconProps): ReactElement;
  displayName?: string;
  /** Lucide's kebab-case name of the drawing, such as `trash-2`. */
  readonly iconName: string;
  /** False for an icon the animated set lacks, drawn by Lucide's still icon instead. */
  readonly animated: boolean;
}

type AnimatedIcon = ForwardRefExoticComponent<
  { size?: number; className?: string } & RefAttributes<IconAnimation>
>;

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

function named<T extends (props: IconProps) => ReactElement>(
  component: T,
  name: string,
  animated: boolean,
): IconComponent {
  const pascal = name.replace(/(^|-)(\w)/g, (_, _dash, c: string) =>
    c.toUpperCase(),
  );
  return Object.assign(component, {
    displayName: `Icon(${pascal})`,
    iconName: name,
    animated,
  });
}

/** An icon of the animated set, played by the control around it. */
function animated(name: string, Animated: AnimatedIcon): IconComponent {
  function Icon({ size = 24, ...rest }: IconProps): ReactElement {
    const box = useRef<HTMLSpanElement>(null);
    const motion = useRef<IconAnimation>(null);
    useEffect(() => {
      const element = box.current;
      return element ? bindToControl(element, () => motion.current) : undefined;
    }, []);
    return (
      <span ref={box} {...boxProps(name, rest)}>
        <Animated ref={motion} size={size} className={styles.motion} />
      </span>
    );
  }
  return named(Icon, name, true);
}

/** Lucide's still icon, for a drawing the animated set lacks. */
function still(name: string, Still: LucideIcon): IconComponent {
  function Icon({ size = 24, ...rest }: IconProps): ReactElement {
    return (
      <span {...boxProps(name, rest)}>
        <Still size={size} aria-hidden="true" />
      </span>
    );
  }
  return named(Icon, name, false);
}

/**
 * Lucide's drawings for use inside another SVG, such as a kind's frame on the resource map,
 * where the box an icon of this module brings cannot go. They never move.
 */
export const SVG_ART = {
  DoorOpen,
  Layers: LucideLayers,
  Route,
  Split: LucideSplit,
} as const;

/** One of `SVG_ART`'s drawings. */
export type SvgArt = LucideIcon;

export const Activity = /* @__PURE__ */ animated("activity", ActivityIcon);
export const AppWindow = /* @__PURE__ */ animated("app-window", AppWindowIcon);
export const ArrowDownToLine = /* @__PURE__ */ animated(
  "arrow-down-to-line",
  ArrowDownToLineIcon,
);
export const ArrowLeft = /* @__PURE__ */ animated("arrow-left", ArrowLeftIcon);
export const ArrowRight = /* @__PURE__ */ animated(
  "arrow-right",
  ArrowRightIcon,
);
export const ArrowRightLeft = /* @__PURE__ */ animated(
  "arrow-right-left",
  ArrowRightLeftIcon,
);
export const Bell = /* @__PURE__ */ animated("bell", BellIcon);
export const Blocks = /* @__PURE__ */ animated("blocks", BlocksIcon);
export const BookOpen = /* @__PURE__ */ animated("book-open", BookOpenIcon);
export const Box = /* @__PURE__ */ animated("box", BoxIcon);
export const Boxes = /* @__PURE__ */ animated("boxes", BoxesIcon);
export const CalendarClock = /* @__PURE__ */ animated(
  "calendar-clock",
  CalendarClockIcon,
);
export const Check = /* @__PURE__ */ animated("check", CheckIcon);
export const ChevronDown = /* @__PURE__ */ animated(
  "chevron-down",
  ChevronDownIcon,
);
export const ChevronLeft = /* @__PURE__ */ animated(
  "chevron-left",
  ChevronLeftIcon,
);
export const ChevronRight = /* @__PURE__ */ animated(
  "chevron-right",
  ChevronRightIcon,
);
export const ChevronUp = /* @__PURE__ */ animated("chevron-up", ChevronUpIcon);
export const ChevronsUpDown = /* @__PURE__ */ animated(
  "chevrons-up-down",
  ChevronsUpDownIcon,
);
export const CircleAlert = /* @__PURE__ */ animated(
  "circle-alert",
  CircleAlertIcon,
);
export const CircleArrowUp = /* @__PURE__ */ animated(
  "circle-arrow-up",
  CircleArrowUpIcon,
);
export const CircleHelp = /* @__PURE__ */ animated(
  "circle-question-mark",
  CircleQuestionMarkIcon,
);
export const CirclePause = /* @__PURE__ */ animated(
  "circle-pause",
  CirclePauseIcon,
);
export const CirclePlay = /* @__PURE__ */ animated(
  "circle-play",
  CirclePlayIcon,
);
export const CircleStop = /* @__PURE__ */ animated(
  "circle-stop",
  CircleStopIcon,
);
export const CircleX = /* @__PURE__ */ animated("circle-x", CircleXIcon);
export const Columns2 = /* @__PURE__ */ animated("columns-2", Columns2Icon);
export const Columns3 = /* @__PURE__ */ animated("columns-3", Columns3Icon);
export const Command = /* @__PURE__ */ animated("command", CommandIcon);
export const Copy = /* @__PURE__ */ animated("copy", CopyIcon);
export const CornerLeftUp = /* @__PURE__ */ animated(
  "corner-left-up",
  CornerLeftUpIcon,
);
export const Cpu = /* @__PURE__ */ animated("cpu", CpuIcon);
export const Database = /* @__PURE__ */ animated("database", DatabaseIcon);
export const Download = /* @__PURE__ */ animated("download", DownloadIcon);
export const Ellipsis = /* @__PURE__ */ animated("ellipsis", EllipsisIcon);
export const ExternalLink = /* @__PURE__ */ animated(
  "external-link",
  ExternalLinkIcon,
);
export const Eye = /* @__PURE__ */ animated("eye", EyeIcon);
export const EyeOff = /* @__PURE__ */ animated("eye-off", EyeOffIcon);
export const FilePlus = /* @__PURE__ */ animated("file-plus", FilePlusIcon);
export const FileSearch = /* @__PURE__ */ animated(
  "file-search",
  FileSearchIcon,
);
export const FileText = /* @__PURE__ */ animated("file-text", FileTextIcon);
export const Folder = /* @__PURE__ */ animated("folder", FolderIcon);
export const FolderPlus = /* @__PURE__ */ animated(
  "folder-plus",
  FolderPlusIcon,
);
export const FolderTree = /* @__PURE__ */ animated(
  "folder-tree",
  FolderTreeIcon,
);
export const FunnelX = /* @__PURE__ */ animated("funnel-x", FunnelXIcon);
export const Globe = /* @__PURE__ */ animated("globe", GlobeIcon);
export const HardDrive = /* @__PURE__ */ animated("hard-drive", HardDriveIcon);
export const History = /* @__PURE__ */ animated("history", HistoryIcon);
export const ImageIcon = /* @__PURE__ */ animated("image", AnimatedImageIcon);
export const Info = /* @__PURE__ */ animated("info", InfoIcon);
export const KeyRound = /* @__PURE__ */ animated("key-round", KeyRoundIcon);
export const Keyboard = /* @__PURE__ */ animated("keyboard", KeyboardIcon);
export const Layers = /* @__PURE__ */ animated("layers", LayersIcon);
export const LayoutDashboard = /* @__PURE__ */ animated(
  "layout-dashboard",
  LayoutDashboardIcon,
);
export const LayoutGrid = /* @__PURE__ */ animated(
  "layout-grid",
  LayoutGridIcon,
);
export const Link = /* @__PURE__ */ animated("link", LinkIcon);
export const List = /* @__PURE__ */ animated("list", ListIcon);
export const ListTree = /* @__PURE__ */ animated("list-tree", ListTreeIcon);
export const LogOut = /* @__PURE__ */ animated("log-out", LogOutIcon);
export const Maximize2 = /* @__PURE__ */ animated("maximize-2", Maximize2Icon);
export const Minimize2 = /* @__PURE__ */ animated("minimize-2", Minimize2Icon);
export const Monitor = /* @__PURE__ */ animated("monitor", MonitorIcon);
export const Moon = /* @__PURE__ */ animated("moon", MoonIcon);
export const MoveVertical = /* @__PURE__ */ animated(
  "move-vertical",
  MoveVerticalIcon,
);
export const Network = /* @__PURE__ */ animated("network", NetworkIcon);
export const Package = /* @__PURE__ */ animated("package", PackageIcon);
export const PackageCheck = /* @__PURE__ */ animated(
  "package-check",
  PackageCheckIcon,
);
export const PackagePlus = /* @__PURE__ */ animated(
  "package-plus",
  PackagePlusIcon,
);
export const PackageSearch = /* @__PURE__ */ animated(
  "package-search",
  PackageSearchIcon,
);
export const PanelBottom = /* @__PURE__ */ animated(
  "panel-bottom",
  PanelBottomIcon,
);
export const PanelRightOpen = /* @__PURE__ */ animated(
  "panel-right-open",
  PanelRightOpenIcon,
);
export const Pin = /* @__PURE__ */ animated("pin", PinIcon);
export const Play = /* @__PURE__ */ animated("play", PlayIcon);
export const Plug = /* @__PURE__ */ animated("plug", PlugIcon);
export const Plus = /* @__PURE__ */ animated("plus", PlusIcon);
export const Power = /* @__PURE__ */ animated("power", PowerIcon);
export const Puzzle = /* @__PURE__ */ animated("puzzle", PuzzleIcon);
export const RefreshCw = /* @__PURE__ */ animated("refresh-cw", RefreshCwIcon);
export const Rocket = /* @__PURE__ */ animated("rocket", RocketIcon);
export const RotateCcw = /* @__PURE__ */ animated("rotate-ccw", RotateCcwIcon);
export const RotateCw = /* @__PURE__ */ animated("rotate-cw", RotateCwIcon);
export const Scan = /* @__PURE__ */ animated("scan", ScanIcon);
export const ScrollText = /* @__PURE__ */ animated(
  "scroll-text",
  ScrollTextIcon,
);
export const Search = /* @__PURE__ */ animated("search", SearchIcon);
export const Server = /* @__PURE__ */ animated("server", ServerIcon);
export const Settings = /* @__PURE__ */ animated("settings", SettingsIcon);
export const ShieldCheck = /* @__PURE__ */ animated(
  "shield-check",
  ShieldCheckIcon,
);
export const ShieldOff = /* @__PURE__ */ animated("shield-off", ShieldOffIcon);
export const SlidersHorizontal = /* @__PURE__ */ animated(
  "sliders-horizontal",
  SlidersHorizontalIcon,
);
export const Square = /* @__PURE__ */ animated("square", SquareIcon);
export const SquareDashed = /* @__PURE__ */ animated(
  "square-dashed",
  SquareDashedIcon,
);
export const SquareTerminal = /* @__PURE__ */ animated(
  "square-terminal",
  SquareTerminalIcon,
);
export const Star = /* @__PURE__ */ animated("star", StarIcon);
export const Sun = /* @__PURE__ */ animated("sun", SunIcon);
export const Tags = /* @__PURE__ */ animated("tags", TagsIcon);
export const Terminal = /* @__PURE__ */ animated("terminal", TerminalIcon);
export const Trash2 = /* @__PURE__ */ animated("trash-2", Trash2Icon);
export const TriangleAlert = /* @__PURE__ */ animated(
  "triangle-alert",
  TriangleAlertIcon,
);
export const Waypoints = /* @__PURE__ */ animated("waypoints", WaypointsIcon);
export const Workflow = /* @__PURE__ */ animated("workflow", WorkflowIcon);
export const X = /* @__PURE__ */ animated("x", XIcon);
export const Zap = /* @__PURE__ */ animated("zap", ZapIcon);
export const ZoomIn = /* @__PURE__ */ animated("zoom-in", ZoomInIcon);
export const ZoomOut = /* @__PURE__ */ animated("zoom-out", ZoomOutIcon);
export const Container = /* @__PURE__ */ still("container", LucideContainer);
export const FileCog = /* @__PURE__ */ still("file-cog", LucideFileCog);
export const ImageUp = /* @__PURE__ */ still("image-up", LucideImageUp);
export const Library = /* @__PURE__ */ still("library", LucideLibrary);
export const Pen = /* @__PURE__ */ still("pen", LucidePen);
export const Split = /* @__PURE__ */ still("split", LucideSplit);
export const Unplug = /* @__PURE__ */ still("unplug", LucideUnplug);
