import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../../design/Toast";
import type { MapFormat } from "../../ipc/generated/MapFormat";
import { flush, mockBackend } from "../../test/ipc";
import { exportFileName, useMapExport } from "./ExportMenu";
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

  it("asks once and writes once when a second export is asked for while one runs", async () => {
    const b = mockBackend({
      "plugin:dialog|save": () => "/home/me/prod-map.png",
      // Never answers: the export is still running.
      map_export: () => new Promise(() => {}),
    });
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(async () => {
      void result.current.exportAs("png");
      void result.current.exportAs("pdf");
      await flush();
    });
    expect(result.current.running).toBe(true);
    expect(b.callsTo("plugin:dialog|save")).toHaveLength(1);
    expect(b.callsTo("map_export")).toHaveLength(1);
    expect(renderMapPng).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.exportAs("pdf");
      await flush();
    });
    expect(b.callsTo("plugin:dialog|save")).toHaveLength(1);
  });

  it("reports an image the webview cannot draw, and exports again afterwards", async () => {
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    const b = mockBackend({
      "plugin:dialog|save": () => "/home/me/prod-map.pdf",
      map_export: (a: { path: string }) => a.path,
    });
    vi.mocked(renderMapPng).mockRejectedValueOnce(
      new Error("The webview could not draw the map as an image"),
    );
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(() => result.current.exportAs("pdf"));
    expect(error).toHaveBeenCalledWith(
      "Could not export the map",
      "The webview could not draw the map as an image",
    );
    expect(b.callsTo("map_export")).toEqual([]);
    expect(result.current.running).toBe(false);

    await act(() => result.current.exportAs("pdf"));
    expect(success).toHaveBeenCalledWith(
      "Map exported as PDF",
      "/home/me/prod-map.pdf",
    );
  });

  it("reports a map that is gone when the dialog closes", async () => {
    const error = vi.spyOn(toast, "error");
    mockBackend({ "plugin:dialog|save": () => "/home/me/prod-map.png" });
    const { result } = renderHook(() =>
      useMapExport({ current: null }, "prod"),
    );

    await act(() => result.current.exportAs("png"));
    expect(renderMapPng).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Could not export the map",
      "The map is not drawn",
    );
  });

  it("reports a save dialog that fails", async () => {
    const error = vi.spyOn(toast, "error");
    mockBackend({
      "plugin:dialog|save": () => {
        throw "dialog unavailable";
      },
    });
    const { result } = renderHook(() => useMapExport(canvas, "prod"));

    await act(() => result.current.exportAs("png"));
    expect(renderMapPng).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Could not export the map",
      "dialog unavailable",
    );
  });
});
