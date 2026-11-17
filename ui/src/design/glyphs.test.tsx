import { render } from "@testing-library/react";
import type { LucideIcon } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { GLYPH_PATHS, type GlyphName } from "./glyphPaths";
import * as glyphModule from "./glyphs";
import { GLYPH_EXPORTS } from "./glyphs";

/** Spec J2, in table order: [lucide-react export name, kebab-case name]. */
const TABLE: readonly (readonly [string, GlyphName])[] = [
  ["Trash2", "trash-2"],
  ["FileCode", "file-code"],
  ["ScrollText", "scroll-text"],
  ["Terminal", "terminal"],
  ["Plug", "plug"],
  ["ArrowRightLeft", "arrow-right-left"],
  ["MoveVertical", "move-vertical"],
  ["RotateCw", "rotate-cw"],
  ["Play", "play"],
  ["CirclePause", "circle-pause"],
  ["CirclePlay", "circle-play"],
  ["ArrowDownToLine", "arrow-down-to-line"],
  ["LogOut", "log-out"],
  ["KeyRound", "key-round"],
  ["Star", "star"],
  ["ShieldOff", "shield-off"],
  ["Zap", "zap"],
  ["Pencil", "pencil"],
  ["RefreshCw", "refresh-cw"],
  ["RotateCcw", "rotate-ccw"],
  ["CircleStop", "circle-stop"],
  ["History", "history"],
  ["CircleArrowUp", "circle-arrow-up"],
  ["PackagePlus", "package-plus"],
  ["ExternalLink", "external-link"],
  ["Square", "square"],
  ["Ellipsis", "ellipsis"],
];

/** SHA-256 of the 27 path strings joined by "\n", printed by the generator. */
const PATHS_DIGEST =
  "abfda64ae0874b4a548fb5cc2fafdf3549f90c09d4a62a9ee8b6121c86217cd1";

const icons = glyphModule as unknown as Record<string, LucideIcon>;

afterEach(() => vi.restoreAllMocks());

async function sha256Hex(text: string): Promise<string> {
  const specifier = "node:crypto";
  const { createHash } = (await import(/* @vite-ignore */ specifier)) as {
    createHash(algorithm: string): {
      update(data: string): { digest(encoding: "hex"): string };
    };
  };
  return createHash("sha256").update(text).digest("hex");
}

test("GLYPH_EXPORTS holds the 27 names of the spec, in order, and each is a component", () => {
  expect([...GLYPH_EXPORTS]).toEqual(TABLE.map(([name]) => name));
  for (const name of GLYPH_EXPORTS) {
    expect(icons[name], name).toBeDefined();
  }
});

test("the module exports the 27 icons and GLYPH_EXPORTS, nothing else", () => {
  expect(Object.keys(glyphModule).sort()).toEqual(
    [...TABLE.map(([name]) => name), "GLYPH_EXPORTS"].sort(),
  );
});

test("GLYPH_PATHS lists the 27 kebab names in table order", () => {
  expect(Object.keys(GLYPH_PATHS)).toEqual(TABLE.map(([, kebab]) => kebab));
});

test("the path data is exactly the drawn art", async () => {
  const joined = TABLE.map(([, kebab]) => GLYPH_PATHS[kebab]).join("\n");
  expect(await sha256Hex(joined)).toBe(PATHS_DIGEST);
});

test.each(TABLE)("%s renders one filled even-odd path", (name, kebab) => {
  const Icon = icons[name];
  const { container } = render(<Icon size={16} />);
  const svgs = container.querySelectorAll("svg");
  expect(svgs).toHaveLength(1);
  const svg = svgs[0];
  expect(svg.getAttribute("width")).toBe("16");
  expect(svg.getAttribute("height")).toBe("16");
  expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(svg.getAttribute("class")).toContain("lucide");
  expect(svg.getAttribute("class")).toContain(`lucide-${kebab}`);
  const paths = svg.querySelectorAll("path");
  expect(paths).toHaveLength(1);
  expect(paths[0].getAttribute("fill")).toBe("currentColor");
  expect(paths[0].getAttribute("fill-rule")).toBe("evenodd");
  expect(paths[0].getAttribute("stroke")).toBe("none");
  expect(paths[0].getAttribute("d")).toBe(GLYPH_PATHS[kebab]);
  expect(svg.children).toHaveLength(1);
});

test("React logs no warning while rendering them with the props the app passes", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const [name] of TABLE) {
    const Icon = icons[name];
    const { unmount } = render(
      <Icon size={14} className="extra" aria-hidden="true" />,
    );
    unmount();
    const bare = render(<Icon />);
    bare.unmount();
  }
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test.each([14, 16, 18, 24])("renders at %i", (size) => {
  for (const [name] of TABLE) {
    const Icon = icons[name];
    const { container, unmount } = render(<Icon size={size} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width"), name).toBe(String(size));
    expect(svg?.getAttribute("height"), name).toBe(String(size));
    unmount();
  }
});

test("the markup carries no colour of its own and no opacity", () => {
  for (const [name] of TABLE) {
    const Icon = icons[name];
    const { container, unmount } = render(
      <button type="button" disabled style={{ color: "rgb(200, 0, 0)" }}>
        <Icon size={16} />
      </button>,
    );
    const svg = container.querySelector("svg");
    const path = container.querySelector("path");
    for (const element of [svg, path]) {
      expect(element?.hasAttribute("style"), name).toBe(false);
      expect(element?.hasAttribute("opacity"), name).toBe(false);
      expect(element?.hasAttribute("fill-opacity"), name).toBe(false);
      expect(element?.hasAttribute("color"), name).toBe(false);
    }
    // The only paint the glyph names is currentColor; no literal colour in the icon.
    expect(svg?.outerHTML, name).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb|hsl/);
    expect(path?.getAttribute("fill")).toBe("currentColor");
    unmount();
  }
});

test("a caller's strokeWidth never draws a stroke", () => {
  for (const [name] of TABLE) {
    const Icon = icons[name];
    const { container, unmount } = render(
      <Icon size={24} strokeWidth={6} absoluteStrokeWidth />,
    );
    const path = container.querySelector("path");
    expect(path?.getAttribute("stroke"), name).toBe("none");
    expect(path?.hasAttribute("stroke-width"), name).toBe(false);
    expect(path?.getAttribute("fill"), name).toBe("currentColor");
    unmount();
  }
});
