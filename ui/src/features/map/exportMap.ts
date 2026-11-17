import manrope400 from "@fontsource/manrope/files/manrope-latin-400-normal.woff2?url";
import manrope500 from "@fontsource/manrope/files/manrope-latin-500-normal.woff2?url";
import manrope600 from "@fontsource/manrope/files/manrope-latin-600-normal.woff2?url";

/** The most pixels an exported image holds; skopos-core's `write_map` checks the same (O22). */
export const MAX_PIXELS = 16_777_216;

const SVG_NS = "http://www.w3.org/2000/svg";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** What the page's stylesheets give each element, written into its `style` (spec O §6.3). */
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
] as const;

/** The Manrope weights `main.tsx` loads, from the latin files of `@fontsource/manrope`. */
const MANROPE: readonly (readonly [number, string])[] = [
  [400, manrope400],
  [500, manrope500],
  [600, manrope600],
];

export interface Size {
  width: number;
  height: number;
}

/** Image pixels per CSS pixel: 2, or less to stay within MAX_PIXELS (spec O22). */
export function exportScale(width: number, height: number): number {
  return Math.min(2, Math.sqrt(MAX_PIXELS / (width * height)));
}

/**
 * The image's size in pixels: the CSS size times `scale`, rounded. Near the limit,
 * rounding both sides up can pass MAX_PIXELS, which skopos-core refuses, so such a
 * size rounds down instead.
 */
export function imageSize(width: number, height: number, scale: number): Size {
  const rounded = {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
  if (rounded.width * rounded.height <= MAX_PIXELS) return rounded;
  return {
    width: Math.floor(width * scale),
    height: Math.floor(height * scale),
  };
}

let fetchedFonts: Promise<string> | null = null;

/** Forgets the fetched fonts, for a test that serves them again. */
export function resetFontsForTest(): void {
  fetchedFonts = null;
}

async function woff2DataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not read the font ${url}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
}

/**
 * `@font-face` rules for Manrope 400, 500 and 600 with each file as a data URL, one per
 * line, since an SVG drawn as an image loads nothing (spec O §6.3 step 4). The files
 * are fetched once per session. A file that cannot be read fails the export rather
 * than drawing its text in another font, and the next export reads the files again.
 */
export function manropeFontFaces(): Promise<string> {
  if (fetchedFonts === null) {
    const pending = Promise.all(
      MANROPE.map(
        async ([weight, url]) =>
          `@font-face { font-family: "Manrope"; font-style: normal; font-weight: ${weight}; ` +
          `src: url(${await woff2DataUrl(url)}) format("woff2"); }`,
      ),
    ).then((rules) => rules.join("\n"));
    pending.catch(() => {
      if (fetchedFonts === pending) fetchedFonts = null;
    });
    fetchedFonts = pending;
  }
  return fetchedFonts;
}

export interface ExportSvg {
  /** A detached copy of the map's SVG that draws alone. */
  svg: SVGSVGElement;
  /** Image pixels per CSS pixel. */
  scale: number;
  /** The image's size in pixels. */
  image: Size;
}

/**
 * The canvas's SVG as a document of its own (spec O §6.3 steps 1–4): every element
 * carries its computed paint and type in `style` and no `class`; a rect in the canvas's
 * background colour comes first, then `fontFaces` in a `style`. The view box is the
 * CSS size and the width and height are the image's, so the webview draws the vectors
 * at the image's resolution rather than scaling a smaller bitmap.
 */
export function mapSvgForExport(
  canvas: HTMLElement,
  fontFaces: string,
): ExportSvg {
  const svg = canvas.querySelector<SVGSVGElement>(":scope > svg");
  if (!svg) throw new Error("The map is not drawn");
  const { width, height } = svg.getBoundingClientRect();
  const scale = exportScale(width, height);
  const image = imageSize(width, height, scale);

  const copy = svg.cloneNode(true) as SVGSVGElement;
  const sources = [svg, ...svg.querySelectorAll<SVGElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<SVGElement>("*")];
  sources.forEach((source, i) => {
    const computed = getComputedStyle(source);
    const target = copies[i];
    for (const name of INLINED) {
      target.style.setProperty(name, computed.getPropertyValue(name));
    }
    target.removeAttribute("class");
  });

  copy.setAttributeNS(XMLNS_NS, "xmlns", SVG_NS);
  copy.setAttribute("width", String(image.width));
  copy.setAttribute("height", String(image.height));
  copy.setAttribute("viewBox", `0 0 ${width} ${height}`);
  copy.setAttribute("preserveAspectRatio", "none");

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", getComputedStyle(canvas).backgroundColor);
  const fonts = document.createElementNS(SVG_NS, "style");
  fonts.textContent = fontFaces;
  copy.prepend(background, fonts);
  return { svg: copy, scale, image };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("The webview could not draw the map as an image"));
    image.src = url;
  });
}

/**
 * SVG text drawn on a canvas of `size` pixels, as a PNG data URL (spec O §6.3). The SVG
 * loads from a data URL, not a Blob URL: the app's CSP allows `data:` images only.
 */
async function drawPng(svg: string, size: Size): Promise<string> {
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The webview cannot draw on a canvas");
  context.drawImage(image, 0, 0, size.width, size.height);
  return canvas.toDataURL("image/png");
}

/**
 * The map canvas as the user sees it, as a PNG (spec O §6.3, O21, O22): `png` is base64
 * without a `data:` prefix, and `scale` is the image's pixels per CSS pixel.
 */
export async function renderMapPng(
  canvas: HTMLElement,
): Promise<{ png: string; scale: number }> {
  const { svg, scale, image } = mapSvgForExport(
    canvas,
    await manropeFontFaces(),
  );
  const url = await drawPng(new XMLSerializer().serializeToString(svg), image);
  return { png: url.slice(url.indexOf(",") + 1), scale };
}
