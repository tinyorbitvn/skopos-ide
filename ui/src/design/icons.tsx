/*
 * Every icon of the interface, in one place. Components import icons from here and never
 * from `lucide-react` (biome.json enforces it).
 *
 * An icon is Lucide's still drawing, from `lucide-react`. Each export keeps its lucide-react
 * name, so `Trash2` here is Lucide's trash-2.
 */

import {
  Activity as LucideActivity,
  AppWindow as LucideAppWindow,
  ArrowDownToLine as LucideArrowDownToLine,
  ArrowLeft as LucideArrowLeft,
  ArrowRight as LucideArrowRight,
  ArrowRightLeft as LucideArrowRightLeft,
  Bell as LucideBell,
  Blocks as LucideBlocks,
  BookOpen as LucideBookOpen,
  Box as LucideBox,
  Boxes as LucideBoxes,
  CalendarClock as LucideCalendarClock,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronsUpDown as LucideChevronsUpDown,
  ChevronUp as LucideChevronUp,
  CircleAlert as LucideCircleAlert,
  CircleArrowUp as LucideCircleArrowUp,
  CirclePause as LucideCirclePause,
  CirclePlay as LucideCirclePlay,
  CircleQuestionMark as LucideCircleQuestionMark,
  CircleStop as LucideCircleStop,
  CircleX as LucideCircleX,
  Columns2 as LucideColumns2,
  Columns3 as LucideColumns3,
  Command as LucideCommand,
  Container as LucideContainer,
  Copy as LucideCopy,
  CornerLeftUp as LucideCornerLeftUp,
  Cpu as LucideCpu,
  Database as LucideDatabase,
  DoorOpen as LucideDoorOpen,
  Download as LucideDownload,
  Ellipsis as LucideEllipsis,
  ExternalLink as LucideExternalLink,
  Eye as LucideEye,
  EyeOff as LucideEyeOff,
  FileCog as LucideFileCog,
  FilePlus as LucideFilePlus,
  FileSearch as LucideFileSearch,
  FileText as LucideFileText,
  Folder as LucideFolder,
  FolderPlus as LucideFolderPlus,
  Folders as LucideFolders,
  FolderTree as LucideFolderTree,
  FunnelX as LucideFunnelX,
  Globe as LucideGlobe,
  HardDrive as LucideHardDrive,
  History as LucideHistory,
  type LucideIcon,
  Image as LucideImage,
  ImageUp as LucideImageUp,
  Info as LucideInfo,
  Keyboard as LucideKeyboard,
  KeyRound as LucideKeyRound,
  Layers as LucideLayers,
  LayoutDashboard as LucideLayoutDashboard,
  LayoutGrid as LucideLayoutGrid,
  Library as LucideLibrary,
  Link as LucideLink,
  List as LucideList,
  ListTree as LucideListTree,
  LogOut as LucideLogOut,
  Maximize2 as LucideMaximize2,
  Microchip as LucideMicrochip,
  Minimize2 as LucideMinimize2,
  Monitor as LucideMonitor,
  Moon as LucideMoon,
  MoveVertical as LucideMoveVertical,
  Network as LucideNetwork,
  Package as LucidePackage,
  PackageCheck as LucidePackageCheck,
  PackagePlus as LucidePackagePlus,
  PackageSearch as LucidePackageSearch,
  PanelBottom as LucidePanelBottom,
  PanelRightOpen as LucidePanelRightOpen,
  Pen as LucidePen,
  Pin as LucidePin,
  Play as LucidePlay,
  Plug as LucidePlug,
  Plus as LucidePlus,
  Power as LucidePower,
  Puzzle as LucidePuzzle,
  RefreshCw as LucideRefreshCw,
  Rocket as LucideRocket,
  RotateCcw as LucideRotateCcw,
  RotateCw as LucideRotateCw,
  Route as LucideRoute,
  Scan as LucideScan,
  ScrollText as LucideScrollText,
  Search as LucideSearch,
  Server as LucideServer,
  Settings as LucideSettings,
  ShieldCheck as LucideShieldCheck,
  ShieldOff as LucideShieldOff,
  SlidersHorizontal as LucideSlidersHorizontal,
  Split as LucideSplit,
  Square as LucideSquare,
  SquareDashed as LucideSquareDashed,
  SquareTerminal as LucideSquareTerminal,
  Star as LucideStar,
  Sun as LucideSun,
  Tags as LucideTags,
  Terminal as LucideTerminal,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Unplug as LucideUnplug,
  Waypoints as LucideWaypoints,
  Workflow as LucideWorkflow,
  X as LucideX,
  Zap as LucideZap,
  ZoomIn as LucideZoomIn,
  ZoomOut as LucideZoomOut,
} from "lucide-react";
import type { CSSProperties, ReactElement } from "react";
import styles from "./icons.module.css";

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

/** Lucide's drawing `name`, in a box that carries the caller's class, style and label. */
function icon(name: string, Drawing: LucideIcon): IconComponent {
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

export const Activity = /* @__PURE__ */ icon("activity", LucideActivity);
export const AppWindow = /* @__PURE__ */ icon("app-window", LucideAppWindow);
export const ArrowDownToLine = /* @__PURE__ */ icon(
  "arrow-down-to-line",
  LucideArrowDownToLine,
);
export const ArrowLeft = /* @__PURE__ */ icon("arrow-left", LucideArrowLeft);
export const ArrowRight = /* @__PURE__ */ icon("arrow-right", LucideArrowRight);
export const ArrowRightLeft = /* @__PURE__ */ icon(
  "arrow-right-left",
  LucideArrowRightLeft,
);
export const Bell = /* @__PURE__ */ icon("bell", LucideBell);
export const Blocks = /* @__PURE__ */ icon("blocks", LucideBlocks);
export const BookOpen = /* @__PURE__ */ icon("book-open", LucideBookOpen);
export const Box = /* @__PURE__ */ icon("box", LucideBox);
export const Boxes = /* @__PURE__ */ icon("boxes", LucideBoxes);
export const CalendarClock = /* @__PURE__ */ icon(
  "calendar-clock",
  LucideCalendarClock,
);
export const Check = /* @__PURE__ */ icon("check", LucideCheck);
export const ChevronDown = /* @__PURE__ */ icon(
  "chevron-down",
  LucideChevronDown,
);
export const ChevronLeft = /* @__PURE__ */ icon(
  "chevron-left",
  LucideChevronLeft,
);
export const ChevronRight = /* @__PURE__ */ icon(
  "chevron-right",
  LucideChevronRight,
);
export const ChevronUp = /* @__PURE__ */ icon("chevron-up", LucideChevronUp);
export const ChevronsUpDown = /* @__PURE__ */ icon(
  "chevrons-up-down",
  LucideChevronsUpDown,
);
export const CircleAlert = /* @__PURE__ */ icon(
  "circle-alert",
  LucideCircleAlert,
);
export const CircleArrowUp = /* @__PURE__ */ icon(
  "circle-arrow-up",
  LucideCircleArrowUp,
);
export const CircleHelp = /* @__PURE__ */ icon(
  "circle-question-mark",
  LucideCircleQuestionMark,
);
export const CirclePause = /* @__PURE__ */ icon(
  "circle-pause",
  LucideCirclePause,
);
export const CirclePlay = /* @__PURE__ */ icon("circle-play", LucideCirclePlay);
export const CircleStop = /* @__PURE__ */ icon("circle-stop", LucideCircleStop);
export const CircleX = /* @__PURE__ */ icon("circle-x", LucideCircleX);
export const Columns2 = /* @__PURE__ */ icon("columns-2", LucideColumns2);
export const Columns3 = /* @__PURE__ */ icon("columns-3", LucideColumns3);
export const Command = /* @__PURE__ */ icon("command", LucideCommand);
export const Container = /* @__PURE__ */ icon("container", LucideContainer);
export const Copy = /* @__PURE__ */ icon("copy", LucideCopy);
export const CornerLeftUp = /* @__PURE__ */ icon(
  "corner-left-up",
  LucideCornerLeftUp,
);
export const Cpu = /* @__PURE__ */ icon("cpu", LucideCpu);
export const Database = /* @__PURE__ */ icon("database", LucideDatabase);
export const Download = /* @__PURE__ */ icon("download", LucideDownload);
export const Ellipsis = /* @__PURE__ */ icon("ellipsis", LucideEllipsis);
export const ExternalLink = /* @__PURE__ */ icon(
  "external-link",
  LucideExternalLink,
);
export const Eye = /* @__PURE__ */ icon("eye", LucideEye);
export const EyeOff = /* @__PURE__ */ icon("eye-off", LucideEyeOff);
export const FileCog = /* @__PURE__ */ icon("file-cog", LucideFileCog);
export const FilePlus = /* @__PURE__ */ icon("file-plus", LucideFilePlus);
export const FileSearch = /* @__PURE__ */ icon("file-search", LucideFileSearch);
export const FileText = /* @__PURE__ */ icon("file-text", LucideFileText);
export const Folder = /* @__PURE__ */ icon("folder", LucideFolder);
export const FolderPlus = /* @__PURE__ */ icon("folder-plus", LucideFolderPlus);
export const FolderTree = /* @__PURE__ */ icon("folder-tree", LucideFolderTree);
export const Folders = /* @__PURE__ */ icon("folders", LucideFolders);
export const FunnelX = /* @__PURE__ */ icon("funnel-x", LucideFunnelX);
export const Globe = /* @__PURE__ */ icon("globe", LucideGlobe);
export const HardDrive = /* @__PURE__ */ icon("hard-drive", LucideHardDrive);
export const History = /* @__PURE__ */ icon("history", LucideHistory);
export const ImageIcon = /* @__PURE__ */ icon("image", LucideImage);
export const ImageUp = /* @__PURE__ */ icon("image-up", LucideImageUp);
export const Info = /* @__PURE__ */ icon("info", LucideInfo);
export const KeyRound = /* @__PURE__ */ icon("key-round", LucideKeyRound);
export const Keyboard = /* @__PURE__ */ icon("keyboard", LucideKeyboard);
export const Layers = /* @__PURE__ */ icon("layers", LucideLayers);
export const LayoutDashboard = /* @__PURE__ */ icon(
  "layout-dashboard",
  LucideLayoutDashboard,
);
export const LayoutGrid = /* @__PURE__ */ icon("layout-grid", LucideLayoutGrid);
export const Library = /* @__PURE__ */ icon("library", LucideLibrary);
export const Link = /* @__PURE__ */ icon("link", LucideLink);
export const List = /* @__PURE__ */ icon("list", LucideList);
export const ListTree = /* @__PURE__ */ icon("list-tree", LucideListTree);
export const LogOut = /* @__PURE__ */ icon("log-out", LucideLogOut);
export const Maximize2 = /* @__PURE__ */ icon("maximize-2", LucideMaximize2);
export const Microchip = /* @__PURE__ */ icon("microchip", LucideMicrochip);
export const Minimize2 = /* @__PURE__ */ icon("minimize-2", LucideMinimize2);
export const Monitor = /* @__PURE__ */ icon("monitor", LucideMonitor);
export const Moon = /* @__PURE__ */ icon("moon", LucideMoon);
export const MoveVertical = /* @__PURE__ */ icon(
  "move-vertical",
  LucideMoveVertical,
);
export const Network = /* @__PURE__ */ icon("network", LucideNetwork);
export const Package = /* @__PURE__ */ icon("package", LucidePackage);
export const PackageCheck = /* @__PURE__ */ icon(
  "package-check",
  LucidePackageCheck,
);
export const PackagePlus = /* @__PURE__ */ icon(
  "package-plus",
  LucidePackagePlus,
);
export const PackageSearch = /* @__PURE__ */ icon(
  "package-search",
  LucidePackageSearch,
);
export const PanelBottom = /* @__PURE__ */ icon(
  "panel-bottom",
  LucidePanelBottom,
);
export const PanelRightOpen = /* @__PURE__ */ icon(
  "panel-right-open",
  LucidePanelRightOpen,
);
export const Pen = /* @__PURE__ */ icon("pen", LucidePen);
export const Pin = /* @__PURE__ */ icon("pin", LucidePin);
export const Play = /* @__PURE__ */ icon("play", LucidePlay);
export const Plug = /* @__PURE__ */ icon("plug", LucidePlug);
export const Plus = /* @__PURE__ */ icon("plus", LucidePlus);
export const Power = /* @__PURE__ */ icon("power", LucidePower);
export const Puzzle = /* @__PURE__ */ icon("puzzle", LucidePuzzle);
export const RefreshCw = /* @__PURE__ */ icon("refresh-cw", LucideRefreshCw);
export const Rocket = /* @__PURE__ */ icon("rocket", LucideRocket);
export const RotateCcw = /* @__PURE__ */ icon("rotate-ccw", LucideRotateCcw);
export const RotateCw = /* @__PURE__ */ icon("rotate-cw", LucideRotateCw);
export const Scan = /* @__PURE__ */ icon("scan", LucideScan);
export const ScrollText = /* @__PURE__ */ icon("scroll-text", LucideScrollText);
export const Search = /* @__PURE__ */ icon("search", LucideSearch);
export const Server = /* @__PURE__ */ icon("server", LucideServer);
export const Settings = /* @__PURE__ */ icon("settings", LucideSettings);
export const ShieldCheck = /* @__PURE__ */ icon(
  "shield-check",
  LucideShieldCheck,
);
export const ShieldOff = /* @__PURE__ */ icon("shield-off", LucideShieldOff);
export const SlidersHorizontal = /* @__PURE__ */ icon(
  "sliders-horizontal",
  LucideSlidersHorizontal,
);
export const Split = /* @__PURE__ */ icon("split", LucideSplit);
export const Square = /* @__PURE__ */ icon("square", LucideSquare);
export const SquareDashed = /* @__PURE__ */ icon(
  "square-dashed",
  LucideSquareDashed,
);
export const SquareTerminal = /* @__PURE__ */ icon(
  "square-terminal",
  LucideSquareTerminal,
);
export const Star = /* @__PURE__ */ icon("star", LucideStar);
export const Sun = /* @__PURE__ */ icon("sun", LucideSun);
export const Tags = /* @__PURE__ */ icon("tags", LucideTags);
export const Terminal = /* @__PURE__ */ icon("terminal", LucideTerminal);
export const Trash2 = /* @__PURE__ */ icon("trash-2", LucideTrash2);
export const TriangleAlert = /* @__PURE__ */ icon(
  "triangle-alert",
  LucideTriangleAlert,
);
export const Unplug = /* @__PURE__ */ icon("unplug", LucideUnplug);
export const Waypoints = /* @__PURE__ */ icon("waypoints", LucideWaypoints);
export const Workflow = /* @__PURE__ */ icon("workflow", LucideWorkflow);
export const X = /* @__PURE__ */ icon("x", LucideX);
export const Zap = /* @__PURE__ */ icon("zap", LucideZap);
export const ZoomIn = /* @__PURE__ */ icon("zoom-in", LucideZoomIn);
export const ZoomOut = /* @__PURE__ */ icon("zoom-out", LucideZoomOut);
