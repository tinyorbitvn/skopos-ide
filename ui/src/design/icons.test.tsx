import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import biomeConfig from "../../../biome.json?raw";
import * as iconModule from "./icons";
import { type IconComponent, Pen, Server, SVG_ART, Trash2 } from "./icons";
import iconSource from "./icons.tsx?raw";

const ICONS = Object.entries(iconModule).filter(
  (entry): entry is [string, IconComponent] => typeof entry[1] === "function",
);

/** Exports whose kebab-case name is not their export's. */
const RENAMED: Record<string, string> = {
  CircleHelp: "circle-question-mark",
  ImageIcon: "image",
};

const kebab = (name: string) =>
  RENAMED[name] ??
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
    .toLowerCase();

const pascal = (name: string) =>
  name.replace(/(^|-)(\w)/g, (_, _dash, c: string) => c.toUpperCase());

/** The icons theSVG UI has no drawing of the same name for, and the drawing each shows. */
const STAND_INS: Record<string, string> = {
  "arrow-down-to-line": "download",
  "arrow-right-left": "arrow-left-right",
  "circle-arrow-up": "arrow-up",
  "columns-3": "columns-2",
  "corner-left-up": "arrow-up",
  "file-cog": "config-file",
  "file-plus": "circle-plus",
  "funnel-x": "funnel",
  "hard-drive": "block-storage",
  history: "rollback",
  "image-up": "upload",
  "key-round": "key",
  library: "registry",
  "list-tree": "folder-tree",
  microchip: "gpu",
  "move-vertical": "arrow-up-down",
  "package-check": "package",
  "package-plus": "deploy",
  "package-search": "helm-chart",
  "panel-bottom": "dock",
  "panel-right-open": "drawer",
  "square-dashed": "circle-dashed",
  "square-terminal": "terminal-prompt",
  "trash-2": "trash",
  "zoom-in": "plus",
  "zoom-out": "minus",
};

afterEach(() => vi.restoreAllMocks());

test("the module exports the icons, SVG_ART, and nothing else", () => {
  expect(ICONS.length).toBeGreaterThan(100);
  const others = Object.keys(iconModule).filter(
    (name) => !ICONS.some(([icon]) => icon === name),
  );
  expect(others).toEqual(["SVG_ART"]);
});

test("each icon is named after its export", () => {
  for (const [name, Icon] of ICONS) {
    expect(Icon.iconName, name).toBe(kebab(name));
  }
});

test("each icon shows theSVG's drawing of its name, or its stand-in", () => {
  for (const [name, Icon] of ICONS) {
    expect(Icon.drawing, name).toBe(STAND_INS[Icon.iconName] ?? Icon.iconName);
  }
  expect(Trash2.drawing).toBe("trash");
  expect(Pen.drawing).toBe("pen");
});

test("every drawing is theSVG UI's fill look, imported from its own module", () => {
  const imports = [
    ...iconSource.matchAll(
      /import \{ (\w+) \} from "@thesvg\/ui-react\/([a-z0-9-]+)";/g,
    ),
  ];
  expect(imports.length).toBeGreaterThan(100);
  for (const [, drawing, slug] of imports) {
    expect(drawing, slug).toBe(`${pascal(slug)}FillIcon`);
  }
  const drawings = new Set(ICONS.map(([, Icon]) => Icon.drawing));
  expect(new Set(imports.map(([, , slug]) => slug))).toEqual(drawings);
  expect(iconSource).not.toMatch(/from "@thesvg\/ui-react"/);
});

test.each(ICONS)(
  "%s draws one svg at its size, in a box named after it",
  (_, Icon) => {
    const { container } = render(<Icon size={16} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.tagName).toBe("SPAN");
    expect(box.dataset.icon).toBe(Icon.iconName);
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.children).toHaveLength(1);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(box.firstElementChild).toBe(svgs[0]);
    expect(svgs[0].getAttribute("width")).toBe("16");
    expect(svgs[0].getAttribute("height")).toBe("16");
    expect(svgs[0].getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svgs[0].getAttribute("aria-hidden")).toBe("true");
    expect(svgs[0].children.length).toBeGreaterThan(0);
  },
);

test("each copy of a drawing has its own mask ids, and its masks are its own", () => {
  const { container } = render(
    <>
      <Server size={16} />
      <Server size={16} />
      <Trash2 size={16} />
    </>,
  );
  const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  for (const svg of container.querySelectorAll("svg")) {
    const own = new Set([...svg.querySelectorAll("[id]")].map((el) => el.id));
    const refs = [...svg.outerHTML.matchAll(/url\(#([^)]+)\)/g)].map(
      (m) => m[1],
    );
    for (const ref of refs) expect(own.has(ref), ref).toBe(true);
  }
});

test("an icon is 24 px when no size is given", () => {
  for (const Icon of [Pen, Trash2]) {
    const { container, unmount } = render(<Icon />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("24");
    unmount();
  }
});

test("class, style and test id go on the box, and a label shows it to assistive technology", () => {
  const { container } = render(
    <Trash2
      size={14}
      className="extra"
      style={{ marginTop: 2 }}
      data-testid="bin"
      role="img"
      aria-label="Delete"
    />,
  );
  const box = container.firstElementChild as HTMLElement;
  expect(box.className).toContain("extra");
  expect(box.className).toContain("icon");
  expect(box.style.marginTop).toBe("2px");
  expect(box.dataset.testid).toBe("bin");
  expect(box.getAttribute("role")).toBe("img");
  expect(box.getAttribute("aria-label")).toBe("Delete");
  expect(box.hasAttribute("aria-hidden")).toBe(false);
});

test("the box is an inline flex box", () => {
  const { container } = render(<Trash2 size={16} />);
  const box = container.firstElementChild as HTMLElement;
  expect(getComputedStyle(box).display).toBe("inline-flex");
});

test("the drawings take the text colour; only their masks hold black and white", () => {
  for (const [name, Icon] of ICONS) {
    const { container, unmount } = render(
      <button type="button" style={{ color: "rgb(200, 0, 0)" }}>
        <Icon size={16} />
      </button>,
    );
    const html = container.querySelector("[data-icon]")?.outerHTML ?? "";
    const masks = html.match(/<mask\b[\s\S]*?<\/mask>/g) ?? [];
    const rest = html.replace(/<mask\b[\s\S]*?<\/mask>/g, "");
    expect(rest, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb|hsl/);
    expect(masks.join(""), name).not.toMatch(
      /#(?!fff\b|000\b)[0-9a-fA-F]{3,8}\b|rgb|hsl/,
    );
    unmount();
  }
});

test("React logs no warning while rendering them with the props the app passes", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const [, Icon] of ICONS) {
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

test("SVG_ART draws Lucide's svg itself, to sit inside another svg", () => {
  for (const [name, Art] of Object.entries(SVG_ART)) {
    const { container, unmount } = render(
      <svg aria-hidden="true">
        <Art x={1} y={2} width={8} height={8} color="#ffffff" />
      </svg>,
    );
    const inner = container.querySelector("svg svg");
    expect(inner, name).not.toBeNull();
    expect(inner?.getAttribute("class"), name).toContain(
      `lucide-${kebab(name)}`,
    );
    expect(container.querySelector("[data-icon]"), name).toBeNull();
    unmount();
  }
});

test("Biome lets only this module import the icon packages", () => {
  const config = JSON.parse(biomeConfig) as {
    linter: { rules: { style: Record<string, unknown> } };
    overrides: { includes: string[]; linter: unknown }[];
  };
  expect(config.linter.rules.style.noRestrictedImports).toEqual({
    level: "error",
    options: {
      patterns: [
        {
          group: [
            "@thesvg/ui-react",
            "@thesvg/ui-react/**",
            "lucide-react",
            "lucide-react/**",
          ],
          message:
            "Import icons from design/icons, the one module that maps them.",
        },
      ],
    },
  });
  expect(config.overrides).toEqual([
    {
      includes: ["ui/src/design/icons.tsx"],
      linter: { rules: { style: { noRestrictedImports: "off" } } },
    },
  ]);
});
