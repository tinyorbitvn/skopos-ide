import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import biomeConfig from "../../../biome.json?raw";
import * as iconModule from "./icons";
import { type IconComponent, Pen, SVG_ART, Trash2 } from "./icons";

const ICONS = Object.entries(iconModule).filter(
  (entry): entry is [string, IconComponent] => typeof entry[1] === "function",
);

/** Exports whose name is not Lucide's current name of the drawing. */
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

afterEach(() => vi.restoreAllMocks());

test("the module exports the icons, SVG_ART, and nothing else", () => {
  expect(ICONS.length).toBeGreaterThan(100);
  const others = Object.keys(iconModule).filter(
    (name) => !ICONS.some(([icon]) => icon === name),
  );
  expect(others).toEqual(["SVG_ART"]);
});

test("each icon names its drawing, Lucide's kebab-case name of its export", () => {
  for (const [name, Icon] of ICONS) {
    expect(Icon.iconName, name).toBe(kebab(name));
  }
});

test.each(ICONS)(
  "%s draws one svg at its size, in a box named after it",
  (_, Icon) => {
    const { container } = render(<Icon size={16} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.tagName).toBe("SPAN");
    expect(box.dataset.icon).toBe(Icon.iconName);
    expect(box.getAttribute("aria-hidden")).toBe("true");
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute("width")).toBe("16");
    expect(svgs[0].getAttribute("height")).toBe("16");
    expect(svgs[0].getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svgs[0].getAttribute("stroke")).toBe("currentColor");
    expect(svgs[0].getAttribute("fill")).toBe("none");
  },
);

test("every icon is Lucide's still drawing, the svg straight inside its box", () => {
  for (const [name, Icon] of ICONS) {
    const { container, unmount } = render(<Icon size={16} />);
    const box = container.firstElementChild as HTMLElement;
    const svg = box.firstElementChild as SVGSVGElement;
    expect(box.children, name).toHaveLength(1);
    expect(svg.tagName.toLowerCase(), name).toBe("svg");
    expect(svg.getAttribute("class") ?? "", name).toMatch(/\blucide\b/);
    unmount();
  }
  const pen = render(<Pen size={16} />).container.querySelector("svg");
  expect(pen?.getAttribute("class")).toContain("lucide-pen");
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

test("the box is an inline flex box, and the stroke is the app's 1.75", () => {
  const { container } = render(<Trash2 size={16} />);
  const box = container.firstElementChild as HTMLElement;
  expect(getComputedStyle(box).display).toBe("inline-flex");
  const svg = container.querySelector("svg") as SVGSVGElement;
  expect(getComputedStyle(svg).strokeWidth).toBe("1.75");
});

test("the markup carries no colour of its own", () => {
  for (const [name, Icon] of ICONS) {
    const { container, unmount } = render(
      <button type="button" style={{ color: "rgb(200, 0, 0)" }}>
        <Icon size={16} />
      </button>,
    );
    const box = container.querySelector("[data-icon]");
    expect(box?.outerHTML, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb|hsl/);
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

test("Biome lets only this module import lucide-react", () => {
  const config = JSON.parse(biomeConfig) as {
    linter: { rules: { style: Record<string, unknown> } };
    overrides: { includes: string[]; linter: unknown }[];
  };
  expect(config.linter.rules.style.noRestrictedImports).toEqual({
    level: "error",
    options: {
      patterns: [
        {
          group: ["lucide-react", "lucide-react/**"],
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
