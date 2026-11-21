import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CSS_FILES, cssRules } from "../test/css";
import {
  donutFontPx,
  UsageDonut,
  type UsageDonutProps,
  usageTone,
} from "./UsageDonut";

const CIRCLE = 2 * Math.PI * 40;
const CPU: UsageDonutProps = {
  name: "CPU",
  pct: 62,
  used: "2.5",
  total: "4",
  unit: "cores",
  size: 40,
  testId: "donut",
};

function draw(props: Partial<UsageDonutProps> = {}) {
  render(<UsageDonut {...CPU} {...props} />);
  const root = screen.getByTestId("donut");
  const svg = screen.getByRole("img");
  return {
    root,
    svg,
    circles: [...svg.querySelectorAll("circle")],
    text: svg.querySelector("text"),
  };
}

/** A circle's dash: the arc's length, then the gap. */
const dash = (circle: Element | undefined) =>
  (circle?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);

test("it draws the track, then the used arc from the top, the share in the middle and the values beside", () => {
  const { root, svg, circles, text } = draw();
  expect([
    svg.getAttribute("aria-label"),
    svg.getAttribute("viewBox"),
    svg.getAttribute("width"),
    svg.getAttribute("height"),
  ]).toEqual(["CPU 62%, 2.5 of 4 cores", "0 0 100 100", "40", "40"]);
  expect(circles).toHaveLength(2);
  const [track, arc] = circles;
  expect([
    track?.getAttribute("r"),
    track?.getAttribute("stroke-width"),
    arc?.getAttribute("r"),
    arc?.getAttribute("stroke-width"),
    arc?.getAttribute("transform"),
  ]).toEqual(["40", "12", "40", "12", "rotate(-90 50 50)"]);
  const [length, gap] = dash(arc);
  expect(length).toBeCloseTo(0.62 * CIRCLE, 6);
  expect(gap).toBeCloseTo(CIRCLE, 6);
  expect([text?.textContent, root.getAttribute("data-tone")]).toEqual([
    "62%",
    "nominal",
  ]);
  const caption = root.querySelector('[aria-hidden="true"]');
  expect([...(caption?.children ?? [])].map((c) => c.textContent)).toEqual([
    "CPU",
    "2.5 / 4 cores",
  ]);
});

test("the arc takes the Nodes table's levels: warning from 80 %, critical from 95 %", () => {
  expect([0, 79, 80, 94, 95, 150].map(usageTone)).toEqual([
    "nominal",
    "nominal",
    "warning",
    "warning",
    "critical",
    "critical",
  ]);
  expect(draw({ pct: 85 }).root.getAttribute("data-tone")).toBe("warning");
  const rules = cssRules(CSS_FILES["/src/design/UsageDonut.module.css"] ?? "");
  const stroke = (selector: string) =>
    rules
      .find((r) => r.selector === selector)
      ?.decls.find(([property]) => property === "stroke")?.[1];
  expect(
    [
      ".track",
      ".arc",
      '.donut[data-tone="warning"] .arc',
      '.donut[data-tone="critical"] .arc',
    ].map(stroke),
  ).toEqual([
    "var(--surface-inset)",
    "var(--status-nominal)",
    "var(--status-warning)",
    "var(--status-critical)",
  ]);
});

test("past the total the arc closes the circle while the middle reads the real share", () => {
  const { root, circles, text } = draw({ pct: 150, used: "6" });
  expect(dash(circles[1])[0]).toBeCloseTo(CIRCLE, 6);
  expect([text?.textContent, root.getAttribute("data-tone")]).toEqual([
    "150%",
    "critical",
  ]);
});

test("at 0 % it draws no arc", () => {
  const { circles, text } = draw({ pct: 0, used: "0" });
  expect([circles.length, text?.textContent]).toEqual([1, "0%"]);
});

test("the share's size follows the donut's: 20 px from 90, 15 from 60, 11 from 40, else 10", () => {
  expect([120, 90, 89, 60, 59, 40, 39, 24].map(donutFontPx)).toEqual([
    20, 20, 15, 15, 11, 11, 10, 10,
  ]);
  // In viewBox units, so that it draws at 11 px on a 40 px donut.
  expect(draw().text?.style.fontSize).toBe("27.5px");
});

test("on a 60 px donut the share draws at 15 px", () => {
  expect(draw({ size: 60 }).text?.style.fontSize).toBe("25px");
});

test.each<[string, Partial<UsageDonutProps>]>([
  ["no share", { pct: null }],
  ["NaN", { pct: Number.NaN }],
  ["Infinity", { pct: Number.POSITIVE_INFINITY }],
  ["no used amount", { used: null }],
  ["no total", { total: null }],
])("with %s it draws only the track and reads a dash (RF1)", (_, props) => {
  const { root, svg, circles, text } = draw(props);
  expect(circles).toHaveLength(1);
  expect([
    text?.textContent,
    svg.getAttribute("aria-label"),
    root.hasAttribute("data-tone"),
    root.textContent,
  ]).toEqual(["—", "CPU unknown", false, "—CPU—"]);
});

test("a label replaces the accessible name, and a bare donut has no caption", () => {
  const { root, svg } = draw({
    label: "CPU requests 62%, 2.5 of 4 cores",
    bare: true,
  });
  expect(svg.getAttribute("aria-label")).toBe(
    "CPU requests 62%, 2.5 of 4 cores",
  );
  expect(root.textContent).toBe("62%");
});

test.each<[string, Partial<UsageDonutProps>, string]>([
  ["critical at 30 %", { pct: 30, tone: "critical" }, "critical"],
  ["nominal at 99 %", { pct: 99, used: "3.96", tone: "nominal" }, "nominal"],
  ["warning at 10 %", { pct: 10, used: "0.4", tone: "warning" }, "warning"],
])("a fixed tone draws the arc %s, whatever the share", (_, props, tone) => {
  expect(draw(props).root.getAttribute("data-tone")).toBe(tone);
});

test("a fixed tone draws nothing while the share is unknown", () => {
  const { root, circles } = draw({ pct: null, tone: "critical" });
  expect([root.hasAttribute("data-tone"), circles.length]).toEqual([false, 1]);
});
