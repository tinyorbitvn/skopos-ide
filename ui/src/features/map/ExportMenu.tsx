import { type RefObject, useCallback, useRef, useState } from "react";
import { Button } from "../../design/Button";
import {
  ChevronDown,
  Download,
  FileText,
  ImageIcon,
  Monitor,
  Scan,
} from "../../design/icons";
import { Menu, type MenuItem } from "../../design/Menu";
import { toast } from "../../design/Toast";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { MapFormat } from "../../ipc/generated/MapFormat";
import { type MapScope, renderMapPng } from "./exportMap";

/** The menu item name and the toast, of each format (spec O §6). */
const FORMATS: Readonly<Record<MapFormat, { name: string; done: string }>> = {
  png: { name: "PNG image", done: "Map exported as PNG" },
  pdf: { name: "PDF document", done: "Map exported as PDF" },
};

/** The menu item name of each scope, whose submenu holds the formats. */
const SCOPES: Readonly<Record<MapScope, string>> = {
  whole: "Whole map",
  view: "Current view",
};

/**
 * `‹stem›-map.png` or `.pdf`, with every character outside A–Z, a–z, 0–9, ".", "_"
 * and "-" turned into "-" (spec O §6.2).
 */
export function exportFileName(stem: string, format: MapFormat): string {
  return `${stem}-map.${format}`.replace(/[^A-Za-z0-9._-]/gu, "-");
}

/**
 * Saves the map drawn in `canvas` (spec O §6.2): the image of the whole map or of the
 * current view, then `map_export`, which opens the save dialog with the default name, and
 * a toast. Cancel ends it quietly. One export runs at a time: another asked for meanwhile
 * does nothing.
 */
export function useMapExport(
  canvas: RefObject<HTMLElement | null>,
  stem: string,
): {
  running: boolean;
  exportAs(format: MapFormat, scope: MapScope): Promise<void>;
} {
  const [running, setRunning] = useState(false);
  const busy = useRef(false);

  const exportAs = useCallback(
    async (format: MapFormat, scope: MapScope) => {
      if (busy.current) return;
      busy.current = true;
      setRunning(true);
      const { done } = FORMATS[format];
      try {
        if (!canvas.current) throw new Error("The map is not drawn");
        const { png, scale } = await renderMapPng(canvas.current, scope);
        const written = await api.mapExport(
          exportFileName(stem, format),
          format,
          png,
          scale,
        );
        if (written === null) return;
        toast.success(done, written);
      } catch (e) {
        toast.error("Could not export the map", failureMessage(e));
      } finally {
        busy.current = false;
        setRunning(false);
      }
    },
    [canvas, stem],
  );

  return { running, exportAs };
}

/** The format items of a scope's submenu. */
function formatItems(
  scope: MapScope,
  exportAs: (format: MapFormat, scope: MapScope) => Promise<void>,
): MenuItem[] {
  return (["png", "pdf"] as const).map((format) => ({
    id: `${scope}-${format}`,
    label: FORMATS[format].name,
    icon:
      format === "png" ? (
        <ImageIcon size={14} aria-hidden="true" />
      ) : (
        <FileText size={14} aria-hidden="true" />
      ),
    testId: `map-export-${scope}-${format}`,
    onSelect: () => void exportAs(format, scope),
  }));
}

/**
 * The toolbar's Export menu (spec O §6.1): "Whole map" or "Current view", each with a
 * submenu of "PNG image" and "PDF document", disabled while the page draws no map and
 * while an export runs.
 */
export function ExportMenu(props: {
  /** The `map-canvas` element, as `MapCanvas` gives it through `canvasRef`. */
  canvas: RefObject<HTMLElement | null>;
  /** The file name before "-map": the cluster's name, or the focus's kind and name. */
  stem: string;
  disabled: boolean;
}) {
  const { running, exportAs } = useMapExport(props.canvas, props.stem);
  return (
    <Menu
      trigger={
        <Button
          size="sm"
          title="Save the whole map or the current view"
          data-testid="map-export"
          disabled={props.disabled || running}
        >
          <Download size={14} aria-hidden="true" />
          Export
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      }
      items={[
        {
          id: "whole",
          label: SCOPES.whole,
          icon: <Scan size={14} aria-hidden="true" />,
          testId: "map-export-whole",
          sub: formatItems("whole", exportAs),
        },
        {
          id: "view",
          label: SCOPES.view,
          icon: <Monitor size={14} aria-hidden="true" />,
          testId: "map-export-view",
          sub: formatItems("view", exportAs),
        },
      ]}
    />
  );
}
