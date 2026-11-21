import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import { Server } from "../../design/icons";
import { CSS_FILES } from "../../test/css";
import {
  type CapacityItem,
  CapacityRow,
  OverviewCard,
  OverviewCell,
  OverviewGrid,
  ShareDonut,
  StatTile,
  type StatTileProps,
  sharePct,
  TileRow,
  TopTable,
  type TopTableProps,
} from "./index";

const css = (name: string) =>
  (CSS_FILES[`/src/features/overview/${name}.module.css`] ?? "").replace(
    /\s+/g,
    " ",
  );

test("the grid is its own container: a cell spans the row, and its span from 900 px", () => {
  render(
    <OverviewGrid testId="grid">
      <OverviewCell span={5}>a</OverviewCell>
      <OverviewCell span={7}>b</OverviewCell>
    </OverviewGrid>,
  );
  const cells = [...screen.getByTestId("grid").children];
  expect(cells.map((c) => c.getAttribute("data-span"))).toEqual(["5", "7"]);
  const text = css("OverviewGrid");
  expect(text).toContain("container: overview / inline-size");
  expect(text).toContain("grid-template-columns: repeat(12, minmax(0, 1fr))");
  expect(text).toContain("gap: var(--space-8)");
  expect(text).toMatch(/\.cell \{[^}]*grid-column: span 12/);
  expect(text).toContain("@container overview (min-width: 900px)");
  for (const span of [4, 5, 6, 7, 8, 12]) {
    expect(text).toContain(
      `.cell[data-span="${span}"] { grid-column: span ${span}; }`,
    );
  }
});

test("a card is a section named by its h2, with its tools in the header", () => {
  render(
    <OverviewCard
      title="Top consumers"
      tools={<button type="button">CPU</button>}
      testId="card"
    >
      <p>body</p>
    </OverviewCard>,
  );
  const card = screen.getByRole("region", { name: "Top consumers" });
  expect(card).toBe(screen.getByTestId("card"));
  expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe(
    "Top consumers",
  );
  expect(within(card).getByRole("button", { name: "CPU" })).toBeTruthy();
  const text = css("OverviewCard");
  for (const decl of [
    "background: var(--surface-card)",
    "border: 1px solid var(--border-subtle)",
    "border-radius: var(--radius-md)",
    "padding: var(--space-8)",
  ]) {
    expect(text).toContain(decl);
  }
});

const TILE: StatTileProps = {
  id: "pods",
  icon: Server,
  number: "166",
  label: "Pods",
  sub: "160 Running · 4 Pending · 2 Failed",
  tone: "danger",
  to: "/c/x/pods",
};

test("a tile is a link to its list, with its number, label and sub-line in its tone", () => {
  render(
    <MemoryRouter>
      <StatTile {...TILE} />
    </MemoryRouter>,
  );
  const tile = screen.getByTestId("overview-tile-pods");
  expect(tile.tagName).toBe("A");
  expect(tile.getAttribute("href")).toBe("/c/x/pods");
  expect(tile.getAttribute("data-tone")).toBe("danger");
  expect(screen.getByTestId("overview-tile-pods-number").textContent).toBe(
    "166",
  );
  expect(screen.getByTestId("overview-tile-pods-sub").textContent).toBe(
    "160 Running · 4 Pending · 2 Failed",
  );
  expect(screen.getByRole("link").textContent).toContain("Pods");
});

test("a tile with nowhere to go is a disabled button", () => {
  render(
    <MemoryRouter>
      <StatTile {...TILE} id="nodes" to={null} tone="neutral" />
    </MemoryRouter>,
  );
  const tile = screen.getByTestId("overview-tile-nodes");
  expect(tile.tagName).toBe("BUTTON");
  expect((tile as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("link")).toBeNull();
});

test("a tile row counts its tiles, and its columns follow its own width", () => {
  render(
    <MemoryRouter>
      <TileRow>
        <StatTile {...TILE} id="a" />
        {null}
        <StatTile {...TILE} id="b" />
        <StatTile {...TILE} id="c" />
      </TileRow>
    </MemoryRouter>,
  );
  const row = screen.getByTestId("overview-tile-a").parentElement;
  expect(row?.getAttribute("data-n")).toBe("3");
  const text = css("TileRow");
  expect(text).toContain("container: tiles / inline-size");
  expect(text).toContain("gap: var(--space-7)");
  expect(text).toContain(
    "flex: 1 1 calc((100% - (var(--cols) - 1) * var(--space-7)) / var(--cols) - 1px)",
  );
  for (const [px, rule] of [
    [352, '.row:not([data-n="1"]) { --cols: 2; }'],
    [
      534,
      '.row[data-n="3"], .row[data-n="5"], .row[data-n="6"] { --cols: 3; }',
    ],
    [716, '.row[data-n="4"] { --cols: 4; }'],
    [898, '.row[data-n="5"] { --cols: 5; }'],
    [1080, '.row[data-n="6"] { --cols: 6; }'],
  ] as const) {
    expect(text).toContain(`@container tiles (min-width: ${px}px) { ${rule} }`);
  }
});

const ITEMS: CapacityItem[] = [
  {
    key: "cpu",
    name: "CPU",
    label: "CPU",
    pct: 39,
    used: "61.2",
    total: "156",
    unit: "cores",
    note: "Requests 52%",
  },
  {
    key: "pods",
    name: "Pods",
    label: "Pods",
    pct: null,
    used: null,
    total: null,
    unit: "pods",
    note: null,
  },
];

test("a capacity row draws a 96 px donut per item with its values and note", () => {
  render(<CapacityRow items={ITEMS} />);
  const cpu = screen.getByTestId("overview-capacity-cpu");
  const svg = within(cpu).getByRole("img");
  expect(svg.getAttribute("width")).toBe("96");
  expect(svg.getAttribute("aria-label")).toBe("CPU 39%, 61.2 of 156 cores");
  expect(screen.getByTestId("overview-capacity-cpu-values").textContent).toBe(
    "61.2 / 156 cores",
  );
  expect(screen.getByTestId("overview-capacity-cpu-note").textContent).toBe(
    "Requests 52%",
  );
  expect(
    within(screen.getByTestId("overview-capacity-pods"))
      .getByRole("img")
      .getAttribute("aria-label"),
  ).toBe("Pods: no data");
  expect(screen.getByTestId("overview-capacity-pods-values").textContent).toBe(
    "No data",
  );
  expect(screen.queryByTestId("overview-capacity-pods-note")).toBeNull();
  const text = css("CapacityRow");
  expect(text).toContain("container: capacity / inline-size");
  expect(text).toContain(
    "grid-template-columns: repeat(auto-fit, minmax(120px, 1fr))",
  );
  expect(text).toMatch(
    /@container capacity \(min-width: 760px\) \{ \.item \{[^}]*flex-direction: row/,
  );
});

test("a share keeps one decimal below 10 % and is unknown without a total", () => {
  expect(sharePct(42, 1000)).toBe(4.2);
  expect(sharePct(380, 1000)).toBe(38);
  expect(sharePct(0.4, 1000)).toBe(0);
  expect(sharePct(5, 0)).toBeNull();
  expect(sharePct(5, null)).toBeNull();
  render(<ShareDonut pct={4.2} label="payments 4.2% of the cluster's CPU" />);
  const svg = screen.getByRole("img");
  expect(svg.getAttribute("width")).toBe("36");
  expect(svg.getAttribute("aria-label")).toBe(
    "payments 4.2% of the cluster's CPU",
  );
  expect(svg.textContent).toBe("4.2%");
});

function table(over: Partial<TopTableProps> = {}) {
  const onOpen = vi.fn();
  const props: TopTableProps = {
    id: "overview-top-pods",
    title: "Top pods",
    nameHead: "Pod",
    valueHead: "CPU",
    total: 10,
    what: "CPU",
    rows: [
      {
        key: "shop/api-0",
        name: "api-0",
        sub: "shop",
        amount: 0.994,
        amountText: "994m",
        onOpen,
      },
    ],
    ...over,
  };
  render(<TopTable {...props} />);
  return onOpen;
}

test("a top table lists its rows with their amount and share, and a name opens its object", () => {
  const onOpen = table();
  const t = screen.getByRole("table", { name: "Top pods" });
  expect(t).toBe(screen.getByTestId("overview-top-pods"));
  expect(
    within(t)
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Pod", "CPU", "Share"]);
  const row = screen.getByTestId("overview-top-pods-row-shop/api-0");
  expect(row.textContent).toContain("api-0");
  expect(row.textContent).toContain("shop");
  expect(row.textContent).toContain("994m");
  expect(within(row).getByRole("img").getAttribute("aria-label")).toBe(
    "api-0 9.9% of the cluster's CPU",
  );
  fireEvent.click(screen.getByTestId("overview-top-pods-open-shop/api-0"));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("an empty top table says that no usage is reported yet", () => {
  table({ rows: [] });
  expect(screen.getByTestId("overview-top-pods").textContent).toContain(
    "No usage reported yet",
  );
});
