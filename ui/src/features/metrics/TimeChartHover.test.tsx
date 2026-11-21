import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { points, T0 } from "../../test/metrics";
import { ChartHoverProvider } from "./chartHover";
import { clockTime } from "./format";
import { TimeChart, type TimeChartProps } from "./TimeChart";

/** Four samples a minute apart from `start`. */
function props(stem: string, start = T0): TimeChartProps {
  return {
    stem,
    title: stem,
    sub: "",
    unit: "cores",
    main: { name: "Usage", points: points([0.1, 0.2, 0.3, 0.4], start) },
    mirror: null,
    refs: [],
    domain: { start: T0, end: T0 + 180, step: 60 },
    period: "1 hour",
    days: false,
    missing: [],
    emptyText: "No samples in this range.",
    view: "chart",
  };
}

const plot = (stem: string) => screen.getByTestId(`metrics-chart-${stem}-plot`);
const hairline = (stem: string) =>
  screen.queryByTestId(`metrics-chart-${stem}-hairline`);
const readout = (stem: string) =>
  screen.queryByTestId(`metrics-chart-${stem}-readout`);

function hover(stem: string, share: number) {
  vi.spyOn(plot(stem), "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 140 }),
  );
  fireEvent.pointerMove(plot(stem), { clientX: share * 300 });
}

test("one hover marks every chart of the panel and only the hovered one reads out", () => {
  render(
    <ChartHoverProvider>
      <TimeChart {...props("a")} />
      <TimeChart {...props("b")} />
    </ChartHoverProvider>,
  );
  hover("a", 1 / 3);
  expect(hairline("a")).not.toBeNull();
  expect(hairline("b")).not.toBeNull();
  expect(readout("a")?.textContent).toContain(clockTime(T0 + 60));
  expect(readout("b")).toBeNull();

  fireEvent.pointerLeave(plot("a"));
  expect(hairline("a")).toBeNull();
  expect(hairline("b")).toBeNull();
});

test("charts whose samples are a step apart mark their nearest samples", () => {
  render(
    <ChartHoverProvider>
      <TimeChart {...props("a")} />
      <TimeChart {...props("b", T0 + 60)} />
    </ChartHoverProvider>,
  );
  hover("a", 0);
  // b's first sample is a minute after a's: it is the nearest to T0.
  expect(hairline("b")).not.toBeNull();
  act(() => plot("b").focus());
  expect(readout("b")?.textContent).toContain(clockTime(T0 + 60));
  expect(readout("a")).toBeNull();
});

test("Escape in the focused chart clears the sample in every chart", () => {
  render(
    <ChartHoverProvider>
      <TimeChart {...props("a")} />
      <TimeChart {...props("b")} />
    </ChartHoverProvider>,
  );
  act(() => plot("a").focus());
  expect(readout("a")?.textContent).toContain(clockTime(T0 + 180));
  expect(hairline("b")).not.toBeNull();

  fireEvent.keyDown(plot("a"), { key: "Escape" });
  expect(readout("a")).toBeNull();
  expect(hairline("b")).toBeNull();
});

test("arrow keys in one chart move the mark in the others", () => {
  render(
    <ChartHoverProvider>
      <TimeChart {...props("a")} />
      <TimeChart {...props("b")} />
    </ChartHoverProvider>,
  );
  act(() => plot("a").focus());
  fireEvent.keyDown(plot("a"), { key: "Home" });
  expect(readout("a")?.textContent).toContain(clockTime(T0));
  const left = (stem: string) => hairline(stem)?.getAttribute("style");
  expect(left("b")).toBe(left("a"));
});
