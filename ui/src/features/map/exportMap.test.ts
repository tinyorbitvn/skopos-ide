import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mapExportRs from "../../../../crates/skopos-core/src/map_export.rs?raw";
import {
  exportScale,
  imageSize,
  MAX_PIXELS,
  manropeFontFaces,
  mapSvgForExport,
  renderMapPng,
  resetFontsForTest,
} from "./exportMap";

/** The properties spec O §6.3 step 2 copies, in its order. */
const INLINED = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
];

const CSS = `
.canvas { background-color: rgb(240, 241, 243); }
.svg { display: block; font-family: sans-serif; }
.line {
  fill: none;
  stroke: rgb(90, 100, 110);
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
  stroke-linecap: round;
}
.dim { opacity: 0.25; }
.label {
  fill: rgb(20, 22, 24);
  font-family: "Manrope", sans-serif;
  font-size: 12px;
  font-weight: 600;
  text-anchor: middle;
}
`;

/** A canvas as MapCanvas draws it: an edge, and a node dimmed by the search. */
const MARKUP = `
<div class="canvas" data-testid="map-canvas">
  <svg class="svg" aria-hidden="true">
    <g transform="translate(10 20) scale(0.5)">
      <g class="edge use"><path class="line" d="M0 0L10 10"/></g>
      <g class="node dim" data-id="Pod/shop/web">
        <circle r="5"/><text class="label">web</text>
      </g>
    </g>
  </svg>
</div>`;

let sheet: HTMLStyleElement;

function canvasOf(width: number, height: number): HTMLElement {
  document.body.innerHTML = MARKUP;
  const canvas = document.querySelector<HTMLElement>(".canvas");
  const svg = canvas?.querySelector("svg");
  if (!canvas || !svg) throw new Error("no canvas");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, width, height),
  );
  return canvas;
}

/** Answers each font with the woff2 signature and its weight, as text. */
function serveFonts(status = 200) {
  const fetch = vi.fn(async (url: string) => {
    const weight = /latin-(\d00)-normal\.woff2$/.exec(url)?.[1] ?? "?";
    return new Response(`wOF2-${weight}`, { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = CSS;
  document.head.append(sheet);
});

afterEach(() => {
  sheet.remove();
  document.body.innerHTML = "";
  resetFontsForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("exportScale and imageSize", () => {
  it("draws a small canvas at twice its CSS size", () => {
    expect(exportScale(1000, 600)).toBe(2);
    expect(imageSize(1000, 600, 2)).toEqual({ width: 2000, height: 1200 });
  });

  it("clamps a 5000 × 5000 canvas to MAX_PIXELS", () => {
    const scale = exportScale(5000, 5000);
    expect(scale).toBeCloseTo(0.8192, 10);
    expect(imageSize(5000, 5000, scale)).toEqual({ width: 4096, height: 4096 });
    expect(MAX_PIXELS).toBe(4096 * 4096);
  });

  it("keeps MAX_PIXELS equal to the limit skopos-core checks", () => {
    const core = /pub const MAX_PIXELS: u64 = ([\d_]+);/.exec(mapExportRs);
    expect(Number(core?.[1].replaceAll("_", ""))).toBe(MAX_PIXELS);
  });

  it("rounds down when rounding would pass MAX_PIXELS", () => {
    const scale = exportScale(4000, 5000);
    // Rounded, 3664 × 4579 would be 240 pixels over the limit.
    expect(imageSize(4000, 5000, scale)).toEqual({ width: 3663, height: 4579 });
  });
});

describe("mapSvgForExport", () => {
  it("writes each element's computed paint and type into its style and drops its class", () => {
    const canvas = canvasOf(1000, 600);
    const page = canvas.querySelector("svg") as SVGSVGElement;
    const { svg } = mapSvgForExport(canvas, "");
    const originals = [page, ...page.querySelectorAll<SVGElement>("*")];
    const copies = [
      svg,
      ...svg.querySelectorAll<SVGElement>(":scope > g, :scope > g *"),
    ];
    expect(copies).toHaveLength(originals.length);
    copies.forEach((copy, i) => {
      const computed = getComputedStyle(originals[i]);
      expect(copy.getAttribute("class")).toBeNull();
      expect([...copy.style].sort()).toEqual([...INLINED].sort());
      for (const name of INLINED) {
        expect([name, copy.style.getPropertyValue(name)]).toEqual([
          name,
          computed.getPropertyValue(name),
        ]);
      }
    });
    const line = svg.querySelector<SVGElement>("path");
    expect(line?.style.stroke).toBe("rgb(90, 100, 110)");
    expect(line?.style.getPropertyValue("stroke-width")).toBe("1.5");
    expect(line?.style.getPropertyValue("stroke-dasharray")).toBe("4 3");
    expect(line?.style.getPropertyValue("stroke-linecap")).toBe("round");
    const node = svg.querySelector<SVGElement>('[data-id="Pod/shop/web"]');
    expect(node?.style.opacity).toBe("0.25");
    const label = svg.querySelector<SVGElement>("text");
    expect(label?.style.fill).toBe("rgb(20, 22, 24)");
    expect(label?.style.getPropertyValue("font-family")).toBe(
      '"Manrope", sans-serif',
    );
    expect(label?.style.getPropertyValue("font-size")).toBe("12px");
    expect(label?.style.getPropertyValue("font-weight")).toBe("600");
    expect(label?.style.getPropertyValue("text-anchor")).toBe("middle");
    expect(svg.style.display).toBe("block");
    expect(svg.querySelector("g")?.getAttribute("transform")).toBe(
      "translate(10 20) scale(0.5)",
    );
  });

  it("leaves the canvas on the page as it was", () => {
    const canvas = canvasOf(1000, 600);
    const before = canvas.innerHTML;
    mapSvgForExport(canvas, "");
    expect(canvas.innerHTML).toBe(before);
  });

  it("puts a rect in the canvas's background colour first, then the fonts", () => {
    const canvas = canvasOf(1000, 600);
    const faces = '@font-face { font-family: "Manrope"; }';
    const { svg } = mapSvgForExport(canvas, faces);
    const [background, fonts, drawing] = [...svg.children];
    expect(background.tagName).toBe("rect");
    expect(background.getAttribute("fill")).toBe("rgb(240, 241, 243)");
    expect(background.getAttribute("width")).toBe("1000");
    expect(background.getAttribute("height")).toBe("600");
    expect(fonts.tagName).toBe("style");
    expect(fonts.textContent).toBe(faces);
    expect(drawing.getAttribute("transform")).toBe(
      "translate(10 20) scale(0.5)",
    );
  });

  it("sizes the SVG as the image and views the canvas's CSS box", () => {
    const canvas = canvasOf(1000, 600);
    const result = mapSvgForExport(canvas, "");
    expect(result.scale).toBe(2);
    expect(result.image).toEqual({ width: 2000, height: 1200 });
    expect(result.svg.getAttribute("width")).toBe("2000");
    expect(result.svg.getAttribute("height")).toBe("1200");
    expect(result.svg.getAttribute("viewBox")).toBe("0 0 1000 600");
    expect(result.svg.getAttribute("preserveAspectRatio")).toBe("none");
  });

  it("serialises to a standalone SVG document", () => {
    const { svg } = mapSvgForExport(canvasOf(1000, 600), "");
    const text = new XMLSerializer().serializeToString(svg);
    expect(text.match(/xmlns="[^"]*"/g)).toEqual([
      'xmlns="http://www.w3.org/2000/svg"',
    ]);
    const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.documentElement.namespaceURI).toBe(
      "http://www.w3.org/2000/svg",
    );
    expect(parsed.querySelector("text")?.textContent).toBe("web");
  });

  it("refuses a canvas with no drawing", () => {
    document.body.innerHTML = '<div class="canvas"></div>';
    const canvas = document.querySelector<HTMLElement>(".canvas");
    expect(() => mapSvgForExport(canvas as HTMLElement, "")).toThrow(
      "The map is not drawn",
    );
  });
});

describe("manropeFontFaces", () => {
  it("embeds Manrope 400, 500 and 600 from the latin woff2 files as data URLs", async () => {
    const fetch = serveFonts();
    const css = await manropeFontFaces();
    expect(fetch.mock.calls.map(([url]) => url.split("/").pop())).toEqual([
      "manrope-latin-400-normal.woff2",
      "manrope-latin-500-normal.woff2",
      "manrope-latin-600-normal.woff2",
    ]);
    const rules = css.split("\n");
    expect(rules).toHaveLength(3);
    for (const [i, weight] of ["400", "500", "600"].entries()) {
      expect(rules[i]).toBe(
        `@font-face { font-family: "Manrope"; font-style: normal; font-weight: ${weight}; ` +
          `src: url(data:font/woff2;base64,${btoa(`wOF2-${weight}`)}) format("woff2"); }`,
      );
    }
  });

  it("fetches the files once per session", async () => {
    const fetch = serveFonts();
    const first = await manropeFontFaces();
    const second = await manropeFontFaces();
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails on a file it cannot read, and reads again next time", async () => {
    serveFonts(404);
    await expect(manropeFontFaces()).rejects.toThrow(
      /Could not read the font .*manrope-latin-400-normal\.woff2: HTTP 404/,
    );
    const fetch = serveFonts();
    await expect(manropeFontFaces()).resolves.toContain("font-weight: 600");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("renderMapPng", () => {
  let draws: { image: unknown; args: number[] }[];
  let canvases: [number, number][];
  let sources: string[];
  let imageFails: boolean;

  /** jsdom decodes no image: this one loads, or fails, as soon as it has a source. */
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(url: string) {
      sources.push(url);
      queueMicrotask(() => (imageFails ? this.onerror?.() : this.onload?.()));
    }
  }

  beforeEach(() => {
    draws = [];
    canvases = [];
    sources = [];
    imageFails = false;
    serveFonts();
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: (image: unknown, ...args: number[]) =>
        draws.push({ image, args }),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      function (this: HTMLCanvasElement, type?: string) {
        canvases.push([this.width, this.height]);
        return `data:${type};base64,iVBORw0KGgo=`;
      },
    );
  });

  it("draws the map at twice its size and returns base64 without a data: prefix", async () => {
    const result = await renderMapPng(canvasOf(1000, 600));
    expect(result).toEqual({ png: "iVBORw0KGgo=", scale: 2 });
    expect(canvases).toEqual([[2000, 1200]]);
    expect(draws).toHaveLength(1);
    expect(draws[0].image).toBeInstanceOf(FakeImage);
    expect(draws[0].args).toEqual([0, 0, 2000, 1200]);
  });

  it("loads the SVG from a data URL, which the app's CSP allows", async () => {
    await renderMapPng(canvasOf(1000, 600));
    const prefix = "data:image/svg+xml;charset=utf-8,";
    expect(sources).toHaveLength(1);
    expect(sources[0].startsWith(prefix)).toBe(true);
    const text = decodeURIComponent(sources[0].slice(prefix.length));
    expect(text.startsWith("<svg ")).toBe(true);
    expect(text).toContain('<rect width="1000" height="600"');
    expect(text).toContain(`base64,${btoa("wOF2-500")}`);
    expect(text).toContain(">web</text>");
  });

  it("draws a 5000 × 5000 map at 4096 × 4096", async () => {
    const result = await renderMapPng(canvasOf(5000, 5000));
    expect(result.scale).toBeCloseTo(0.8192, 10);
    expect(canvases).toEqual([[4096, 4096]]);
  });

  it("fails when the webview cannot load the image", async () => {
    imageFails = true;
    await expect(renderMapPng(canvasOf(1000, 600))).rejects.toThrow(
      "The webview could not draw the map as an image",
    );
    expect(draws).toEqual([]);
    expect(canvases).toEqual([]);
  });
});
