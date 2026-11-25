import { act, fireEvent, screen } from "@testing-library/react";
import type { MapScope } from "../features/map/exportMap";
import type { MapFormat } from "../ipc/generated/MapFormat";
import { flush } from "./ipc";

/** What a mocked `renderMapPng` draws: a PNG signature, at scale 2. */
export const MAP_IMAGE = { png: "iVBORw0KGgo=", scale: 2 };

/** The Export button of a map page's toolbar (spec O §6.1). */
export function exportButton(): HTMLButtonElement {
  return screen.getByTestId("map-export") as HTMLButtonElement;
}

/**
 * Opens the Export menu, picks a scope, then a format in its submenu, and lets the export
 * run as far as it can.
 */
export async function pickExport(
  format: MapFormat,
  scope: MapScope,
): Promise<void> {
  fireEvent.keyDown(exportButton(), { key: "Enter" });
  fireEvent.keyDown(screen.getByTestId(`map-export-${scope}`), {
    key: "ArrowRight",
  });
  fireEvent.click(await screen.findByTestId(`map-export-${scope}-${format}`));
  await act(flush);
}
