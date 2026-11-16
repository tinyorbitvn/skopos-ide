import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { CSS_FILES, cssRules } from "../test/css";
import { LOGO_MARK_PATH } from "./logoMark";
import { SkoposLogo } from "./SkoposLogo";

test("a decorative 48 px svg by default", () => {
  const { container } = render(<SkoposLogo />);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("viewBox")).toBe("0 0 256 256");
  expect(svg?.getAttribute("width")).toBe("48");
  expect(svg?.getAttribute("height")).toBe("48");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("focusable")).toBe("false");
});

test("takes a size and a class", () => {
  const { container } = render(<SkoposLogo size={16} className="mine" />);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("width")).toBe("16");
  expect(svg?.getAttribute("height")).toBe("16");
  expect(svg?.classList.contains("mine")).toBe(true);
});

test("a rounded tile under the orbit mark, as the app icon draws them", () => {
  const { container } = render(<SkoposLogo />);
  const tile = container.querySelector("rect");
  expect(tile?.getAttribute("class")).toBe("tile");
  expect(tile?.getAttribute("rx")).toBe("56");
  const mark = container.querySelector("path");
  expect(mark?.getAttribute("class")).toBe("mark");
  expect(mark?.getAttribute("d")).toBe(LOGO_MARK_PATH);
  expect(mark?.getAttribute("fill-rule")).toBe("evenodd");
  expect(mark?.getAttribute("transform")).toBe("translate(32 32) scale(0.75)");
  // No literal colour in the markup: the stylesheet paints it.
  expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb/);
});

test("white on navy in both themes", () => {
  const rules = cssRules(CSS_FILES["/src/design/SkoposLogo.module.css"] ?? "");
  const fill = (selector: string) =>
    rules
      .find((r) => r.selector === selector)
      ?.decls.find(([p]) => p === "fill")?.[1];
  expect(fill(".tile")).toBe("#000055");
  expect(fill(".mark")).toBe("#ffffff");
});
