import { save } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Download, FileText, ImageIcon } from "lucide-react";
import { type RefObject, useCallback, useRef, useState } from "react";
import { Button } from "../../design/Button";
import { Menu } from "../../design/Menu";
import { toast } from "../../design/Toast";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { MapFormat } from "../../ipc/generated/MapFormat";
import { renderMapPng } from "./exportMap";

/** The menu item and save filter name, and the toast, of each format (spec O §6). */
const FORMATS: Readonly<Record<MapFormat, { name: string; done: string }>> = {
  png: { name: "PNG image", done: "Map exported as PNG" },
  pdf: { name: "PDF document", done: "Map exported as PDF" },
};

/**
 * `‹stem›-map.png` or `.pdf`, with every character outside A–Z, a–z, 0–9, ".", "_"
 * and "-" turned into "-" (spec O §6.2).
 */
export function exportFileName(stem: string, format: MapFormat): string {
  return `${stem}-map.${format}`.replace(/[^A-Za-z0-9._-]/gu, "-");
}

/**
 * Saves the map drawn in `canvas` (spec O §6.2): the save dialog with the default name
 * and that format's filter, the image, then `map_export` and a toast. Cancel ends it
 * quietly. One export runs at a time: another asked for meanwhile does nothing.
 */
export function useMapExport(
  canvas: RefObject<HTMLElement | null>,
  stem: string,
): { running: boolean; exportAs(format: MapFormat): Promise<void> } {
  const [running, setRunning] = useState(false);
  const busy = useRef(false);

  const exportAs = useCallback(
    async (format: MapFormat) => {
      if (busy.current) return;
      busy.current = true;
      setRunning(true);
      const { name, done } = FORMATS[format];
      try {
        const path = await save({
          defaultPath: exportFileName(stem, format),
          filters: [{ name, extensions: [format] }],
        });
        if (path === null) return;
        if (!canvas.current) throw new Error("The map is not drawn");
        const { png, scale } = await renderMapPng(canvas.current);
        const written = await api.mapExport(path, format, png, scale);
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

/**
 * The toolbar's Export menu (spec O §6.1): "PNG image" or "PDF document", disabled
 * while the page draws no map and while an export runs.
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
          title="Save the map as you see it"
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
          id: "png",
          label: FORMATS.png.name,
          icon: <ImageIcon size={14} aria-hidden="true" />,
          testId: "map-export-png",
          onSelect: () => void exportAs("png"),
        },
        {
          id: "pdf",
          label: FORMATS.pdf.name,
          icon: <FileText size={14} aria-hidden="true" />,
          testId: "map-export-pdf",
          onSelect: () => void exportAs("pdf"),
        },
      ]}
    />
  );
}
