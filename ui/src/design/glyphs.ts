import { createLucideIcon, type LucideIcon } from "lucide-react";
import { GLYPH_PATHS, type GlyphName } from "./glyphPaths";

/*
 * The 27 action icons, drawn for SkoposIDE (see glyphPaths.ts). Each is built with
 * lucide-react's public createLucideIcon under the lucide export name, so a consumer
 * changes only its import source. The path is a filled outline: it takes the text colour
 * through currentColor and draws no stroke, so a caller's strokeWidth or the global
 * svg.lucide stroke-width change nothing. Not re-exported from design/index.ts, because a
 * name such as Square or History must not reach every importer of the design module.
 */
function glyph(name: GlyphName): LucideIcon {
  return createLucideIcon(name, [
    [
      "path",
      {
        d: GLYPH_PATHS[name],
        fill: "currentColor",
        fillRule: "evenodd",
        stroke: "none",
        key: "glyph",
      },
    ],
  ]);
}

export const Trash2 = glyph("trash-2");
export const FileCode = glyph("file-code");
export const ScrollText = glyph("scroll-text");
export const Terminal = glyph("terminal");
export const Plug = glyph("plug");
export const ArrowRightLeft = glyph("arrow-right-left");
export const MoveVertical = glyph("move-vertical");
export const RotateCw = glyph("rotate-cw");
export const Play = glyph("play");
export const CirclePause = glyph("circle-pause");
export const CirclePlay = glyph("circle-play");
export const ArrowDownToLine = glyph("arrow-down-to-line");
export const LogOut = glyph("log-out");
export const KeyRound = glyph("key-round");
export const Star = glyph("star");
export const ShieldOff = glyph("shield-off");
export const Zap = glyph("zap");
export const Pencil = glyph("pencil");
export const RefreshCw = glyph("refresh-cw");
export const RotateCcw = glyph("rotate-ccw");
export const CircleStop = glyph("circle-stop");
export const History = glyph("history");
export const CircleArrowUp = glyph("circle-arrow-up");
export const PackagePlus = glyph("package-plus");
export const ExternalLink = glyph("external-link");
export const Square = glyph("square");
export const Ellipsis = glyph("ellipsis");

/** The 27 export names in the spec's order, for tests and for the lint rule's list. */
export const GLYPH_EXPORTS = [
  "Trash2",
  "FileCode",
  "ScrollText",
  "Terminal",
  "Plug",
  "ArrowRightLeft",
  "MoveVertical",
  "RotateCw",
  "Play",
  "CirclePause",
  "CirclePlay",
  "ArrowDownToLine",
  "LogOut",
  "KeyRound",
  "Star",
  "ShieldOff",
  "Zap",
  "Pencil",
  "RefreshCw",
  "RotateCcw",
  "CircleStop",
  "History",
  "CircleArrowUp",
  "PackagePlus",
  "ExternalLink",
  "Square",
  "Ellipsis",
] as const;
