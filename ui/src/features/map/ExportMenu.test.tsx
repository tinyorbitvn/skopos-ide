import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../../design/Toast";
import type { MapFormat } from "../../ipc/generated/MapFormat";
import { flush, mockBackend } from "../../test/ipc";
import { ExportMenu, exportFileName, useMapExport } from "./ExportMenu";
import { renderMapPng } from "./exportMap";

vi.mock("./exportMap", () => ({ renderMapPng: vi.fn() }));

const IMAGE = { png: "iVBORw0KGgo=", scale: 2 };

beforeEach(() => {
  vi.mocked(renderMapPng).mockReset().mockResolvedValue(IMAGE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportFileName", () => {
  it.each<[string, MapFormat, string]>([
    ["prod", "png", "prod-map.png"],
    ["deployment-payments-api", "pdf", "deployment-payments-api-map.pdf"],
    ["kind-skopos e2e", "png", "kind-skopos-e2e-map.png"],
    [
      "arn:aws:eks:eu-west-1:1:cluster/prod",
      "pdf",
      "arn-aws-eks-eu-west-1-1-cluster-prod-map.pdf",
    ],
    ["db_v1.2", "png", "db_v1.2-map.png"],
    ["café", "png", "caf--map.png"],
    ["web\u{1F600}", "pdf", "web--map.pdf"],
  ])("%s as %s is %s", (stem, format, name) => {
    expect(exportFileName(stem, format)).toBe(name);
  });
});

describe("useMapExport", () => {
  const canvas = { current: document.createElement("div") };

  it("calls the command once when a second export is asked for while one runs", async () => {
    const b = mockBackend({
      // Never answers: the export is still running.
      map_export: () => new Promise(() => {}),
    });
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(async () => {
      void result.current.exportAs("png", "view");
      void result.current.exportAs("pdf", "whole");
      await flush();
    });
    expect(result.current.running).toBe(true);
    expect(b.callsTo("map_export")).toHaveLength(1);
    expect(renderMapPng).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.exportAs("pdf", "whole");
      await flush();
    });
    expect(b.callsTo("map_export")).toHaveLength(1);
  });

  it("draws the scope asked for and gives the command the suggested name, format, image and scale, and no path", async () => {
    const success = vi.spyOn(toast, "success");
    const b = mockBackend({
      map_export: () => "/home/me/chosen.pdf",
    });
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(() => result.current.exportAs("pdf", "whole"));
    expect(renderMapPng).toHaveBeenCalledWith(canvas.current, "whole");
    const [call] = b.callsTo("map_export");
    expect(call).toEqual({
      suggestedName: "prod-map.pdf",
      format: "pdf",
      png: IMAGE.png,
      scale: IMAGE.scale,
    });
    expect(success).toHaveBeenCalledWith(
      "Map exported as PDF",
      "/home/me/chosen.pdf",
    );
  });

  it("ends quietly when the dialog is cancelled", async () => {
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    mockBackend({ map_export: () => null });
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(() => result.current.exportAs("png", "view"));
    expect(error).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(result.current.running).toBe(false);
  });

  it("reports an image the webview cannot draw, and exports again afterwards", async () => {
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    const b = mockBackend({
      map_export: () => "/home/me/prod-map.pdf",
    });
    vi.mocked(renderMapPng).mockRejectedValueOnce(
      new Error("The webview could not draw the map as an image"),
    );
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(() => result.current.exportAs("pdf", "view"));
    expect(error).toHaveBeenCalledWith(
      "Could not export the map",
      "The webview could not draw the map as an image",
    );
    expect(b.callsTo("map_export")).toEqual([]);
    expect(result.current.running).toBe(false);

    await act(() => result.current.exportAs("pdf", "view"));
    expect(success).toHaveBeenCalledWith(
      "Map exported as PDF",
      "/home/me/prod-map.pdf",
    );
  });

  it("reports a map that is gone before anything is asked", async () => {
    const error = vi.spyOn(toast, "error");
    const b = mockBackend({ map_export: () => "/home/me/prod-map.png" });
    const { result } = renderHook(() =>
      useMapExport({ current: null }, "prod"),
    );

    await act(() => result.current.exportAs("png", "view"));
    expect(renderMapPng).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Could not export the map",
      "The map is not drawn",
    );
    expect(b.callsTo("map_export")).toEqual([]);
  });

  it("reports a command that fails", async () => {
    const error = vi.spyOn(toast, "error");
    mockBackend({
      map_export: () => {
        throw "dialog unavailable";
      },
    });
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(() => result.current.exportAs("png", "view"));
    expect(error).toHaveBeenCalledWith(
      "Could not export the map",
      "dialog unavailable",
    );
  });
});

describe("ExportMenu", () => {
  const canvas = { current: document.createElement("div") };
  const labels = (testIds: string[]) =>
    testIds.map((id) => screen.getByTestId(id).textContent);

  it("asks for the whole map or the current view, then the format", async () => {
    const b = mockBackend({ map_export: () => "/home/me/prod-map.png" });
    render(<ExportMenu canvas={canvas} stem="prod" disabled={false} />);
    const button = screen.getByTestId("map-export");
    expect(button.getAttribute("title")).toBe(
      "Save the whole map or the current view",
    );
    fireEvent.keyDown(button, { key: "Enter" });
    expect(labels(["map-export-whole", "map-export-view"])).toEqual([
      "Whole map",
      "Current view",
    ]);
    expect(screen.queryByTestId("map-export-whole-png")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("map-export-view"), {
      key: "ArrowRight",
    });
    await screen.findByTestId("map-export-view-png");
    expect(labels(["map-export-view-png", "map-export-view-pdf"])).toEqual([
      "PNG image",
      "PDF document",
    ]);
    fireEvent.click(screen.getByTestId("map-export-view-png"));
    await act(flush);
    expect(renderMapPng).toHaveBeenCalledWith(canvas.current, "view");
    expect(b.callsTo("map_export")).toEqual([
      {
        suggestedName: "prod-map.png",
        format: "png",
        png: IMAGE.png,
        scale: IMAGE.scale,
      },
    ]);
  });
});
