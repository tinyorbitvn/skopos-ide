import { describe, expect, it } from "vitest";
import { shape } from "./packK8sIcons.mjs";

const SVG = "http://www.w3.org/2000/svg";

function element(tag, attributes) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

describe("shape", () => {
  it("turns an ellipse into two arcs from its left end", () => {
    const el = element("ellipse", { cx: 12, cy: 8.5, rx: 5, ry: 3.25 });
    expect(shape(el, "ellipse")).toBe(
      "M7 8.5 a5 3.25 0 1 0 10 0 a5 3.25 0 1 0 -10 0 Z",
    );
  });

  it("turns a circle into the same arcs with one radius", () => {
    const el = element("circle", { cx: 12, cy: 8.5, r: 5 });
    expect(shape(el, "circle")).toBe(
      "M7 8.5 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 Z",
    );
  });
});
