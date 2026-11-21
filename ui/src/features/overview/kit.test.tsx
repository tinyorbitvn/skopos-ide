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
  OverviewPage,
  type OverviewRow,
  OverviewTable,
  type OverviewTableProps,
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
test("a capacity item's level fixes its donut's tone, else the share sets it", () => {
  render(
    <CapacityRow
      items={[
        { ...ITEMS[0], key: "healthy", level: "critical" },
        { ...ITEMS[0], key: "plain", pct: 85 },
      ]}
    />,
  );
  const tone = (key: string) =>
    within(screen.getByTestId(`overview-capacity-${key}`))
      .getByRole("img")
      .parentElement?.getAttribute("data-tone");
  expect([tone("healthy"), tone("plain")]).toEqual(["critical", "warning"]);
});

test("a capacity item without a unit ends its values and its name at the number", () => {
  render(
    <CapacityRow
      items={[
        {
          ...ITEMS[0],
          key: "healthy",
          label: "Healthy workloads",
          pct: 67,
          used: "4",
          total: "6",
          unit: "",
        },
      ]}
    />,
  );
  const item = within(screen.getByTestId("overview-capacity-healthy"));
  expect([
    item.getByRole("img").getAttribute("aria-label"),
    screen.getByTestId("overview-capacity-healthy-values").textContent,
  ]).toEqual(["Healthy workloads 67%, 4 of 6", "4 / 6"]);
});

test("a top table can name its donut column and draw each row's own usage in place of its share", () => {
  table({
    shareHead: "Usage",
    total: null,
    rows: [
      {
        key: "worker-03",
        name: "worker-03",
        sub: "worker · eu-west-1c",
        amount: 13.3,
        amountText: "13.3 cores",
        own: { pct: 84, label: "worker-03 CPU 84%, 13.3 of 15.8 cores" },
        onOpen: () => {},
      },
      {
        key: "worker-01",
        name: "worker-01",
        sub: "worker",
        amount: 2,
        amountText: "2 cores",
        own: {
          pct: 20,
          label: "worker-01 CPU 20%, 2 of 10 cores",
          level: "critical",
        },
        onOpen: () => {},
      },
      {
        key: "worker-02",
        name: "worker-02",
        sub: "worker",
        amount: 0,
        amountText: "0m",
        own: { pct: null, label: "worker-02 CPU: no data" },
        onOpen: () => {},
      },
    ],
  });
  expect(
    within(screen.getByTestId("overview-top-pods"))
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Pod", "CPU", "Usage"]);
  const donut = (key: string) =>
    within(screen.getByTestId(`overview-top-pods-row-${key}`)).getByRole("img");
  const busy = donut("worker-03");
  expect([
    busy.getAttribute("aria-label"),
    busy.textContent,
    busy.parentElement?.getAttribute("data-tone"),
  ]).toEqual(["worker-03 CPU 84%, 13.3 of 15.8 cores", "84%", "warning"]);
  expect(donut("worker-01").parentElement?.getAttribute("data-tone")).toBe(
    "critical",
  );
  const unknown = donut("worker-02");
  expect([unknown.getAttribute("aria-label"), unknown.textContent]).toEqual([
    "worker-02 CPU: no data",
    "—",
  ]);
});

test("an overview page has the list toolbar's title and the chosen namespaces over a body that scrolls", () => {
  const onKeyDown = vi.fn();
  const { rerender } = render(
    <OverviewPage
      title="Storage overview"
      testId="storage-overview"
      namespaces={["payments", "checkout"]}
      onKeyDown={onKeyDown}
    >
      <p data-testid="page-body">cards</p>
    </OverviewPage>,
  );
  const page = screen.getByTestId("storage-overview");
  const title = screen.getByTestId("storage-overview-title");
  expect([title.tagName, title.textContent]).toEqual([
    "H2",
    "Storage overview",
  ]);
  const note = screen.getByTestId("storage-overview-namespaces");
  expect(note.textContent).toBe("Namespaces: payments, checkout");
  expect(note.querySelector('[data-icon="layers"]')).not.toBeNull();
  expect(page.contains(screen.getByTestId("page-body"))).toBe(true);
  fireEvent.keyDown(screen.getByTestId("page-body"), { key: "Escape" });
  expect(onKeyDown).toHaveBeenCalledTimes(1);

  rerender(
    <OverviewPage
      title="Storage overview"
      testId="storage-overview"
      namespaces={[]}
    >
      <p data-testid="page-body">cards</p>
    </OverviewPage>,
  );
  expect(screen.queryByTestId("storage-overview-namespaces")).toBeNull();

  const text = css("OverviewPage");
  expect(text).toMatch(
    /\.page \{[^}]*position: relative;[^}]*overflow: hidden;/,
  );
  expect(text).toMatch(
    /\.toolbar \{[^}]*display: flex;[^}]*gap: var\(--space-5\);/,
  );
  expect(text).toMatch(/\.title \{[^}]*font-size: 14px;[^}]*font-weight: 600;/);
  expect(text).toMatch(/\.grow \{ flex: 1; \}/);
  expect(text).toMatch(/\.body \{[^}]*min-height: 0;[^}]*overflow: auto;/);
});

/** Three rows: a link (a zone), a button (an object) and plain text. */
function overviewTable(over: Partial<OverviewTableProps> = {}) {
  const onOpen = vi.fn();
  const rows: OverviewRow[] = [
    {
      key: "eu-west-1a",
      name: "eu-west-1a",
      sub: "eu-west-1",
      title: "Open the Node topology",
      to: "/cluster/c1/topology",
      cells: [
        { text: "12" },
        { text: "1 NotReady", tone: "bad" },
        {
          donut: {
            pct: 61,
            used: "31.2",
            total: "51.2",
            unit: "cores",
            label: "eu-west-1a CPU 61%, 31.2 of 51.2 cores",
            caption: "31.2 / 51.2 cores",
          },
        },
      ],
    },
    {
      key: "shop/web",
      name: "web",
      sub: "shop",
      onOpen,
      cells: [
        { text: "3" },
        { text: "Pending", tone: "warn" },
        {
          donut: {
            pct: 30,
            used: "1.2",
            total: "4",
            unit: "cores",
            label: "web CPU 30%, 1.2 of 4 cores",
            caption: "1.2 / 4 cores",
            level: "critical",
          },
        },
      ],
    },
    {
      key: "none",
      name: "No zone",
      sub: "",
      cells: [
        { text: "—", tone: "dim" },
        {
          text: "Debian 12",
          mono: true,
          title: "Debian GNU/Linux 12 (bookworm)",
        },
        {
          donut: {
            pct: null,
            used: null,
            total: null,
            unit: "cores",
            label: "No zone CPU: no data",
            caption: "No data",
          },
        },
      ],
    },
  ];
  render(
    <MemoryRouter>
      <OverviewTable
        id="nodes-zones"
        title="By zone"
        label="Nodes by zone"
        columns={[
          { head: "Zone", width: "minmax(0, 1.4fr)" },
          { head: "Nodes", width: "64px", align: "end" },
          { head: "State", width: "minmax(0, 1fr)" },
          { head: "CPU", width: "minmax(0, 1fr)" },
        ]}
        rows={rows}
        minWidth={520}
        empty={{
          icon: Server,
          title: "This cluster has no nodes",
          text: "Nodes appear here once the cluster lists them.",
        }}
        footer="CPU and memory: usage from metrics-server"
        {...over}
      />
    </MemoryRouter>,
  );
  return onOpen;
}

/** The cells of a row, the name's first. */
const cellsOf = (key: string) =>
  within(screen.getByTestId(`nodes-zones-row-${key}`)).getAllByRole("cell");

test("an overview table lays each row on the columns' tracks, under a header per column", () => {
  overviewTable();
  const t = screen.getByRole("table", { name: "Nodes by zone" });
  expect(t).toBe(screen.getByTestId("nodes-zones"));
  expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("By zone");
  expect(
    within(t)
      .getAllByRole("columnheader")
      .map((h) => [h.textContent, h.getAttribute("data-align")]),
  ).toEqual([
    ["Zone", "start"],
    ["Nodes", "end"],
    ["State", "start"],
    ["CPU", "start"],
  ]);
  expect(within(t).getAllByRole("row")).toHaveLength(4);
  expect(t.style.getPropertyValue("--ot-columns")).toBe(
    "minmax(0, 1.4fr) 64px minmax(0, 1fr) minmax(0, 1fr)",
  );
  expect(t.style.getPropertyValue("--ot-min-width")).toBe("520px");
  expect(screen.getByTestId("nodes-zones-footer").textContent).toBe(
    "CPU and memory: usage from metrics-server",
  );
  const text = css("OverviewTable");
  expect(text).toContain("grid-template-columns: var(--ot-columns)");
  expect(text).toContain("min-width: var(--ot-min-width, 0)");
  expect(text).toMatch(/\.scroll \{[^}]*overflow-x: auto;/);
});

test("an end column right-aligns in the mono face, and a cell's tone colors it", () => {
  overviewTable();
  const zone = cellsOf("eu-west-1a");
  expect([
    zone[1]?.textContent,
    zone[1]?.getAttribute("data-align"),
    zone[2]?.getAttribute("data-tone"),
    zone[2]?.hasAttribute("data-mono"),
  ]).toEqual(["12", "end", "bad", false]);
  expect(cellsOf("shop/web")[2]?.getAttribute("data-tone")).toBe("warn");
  const plain = cellsOf("none");
  expect([
    plain[1]?.getAttribute("data-tone"),
    plain[2]?.hasAttribute("data-mono"),
    plain[2]?.getAttribute("title"),
  ]).toEqual(["dim", true, "Debian GNU/Linux 12 (bookworm)"]);
  const text = css("OverviewTable");
  expect(text).toMatch(
    /\.cell\[data-align="end"\] \{[^}]*justify-content: flex-end;[^}]*font: var\(--type-mono\);/,
  );
  expect(text).toContain(".cell[data-mono] { font: var(--type-mono); }");
  for (const [tone, color] of [
    ["warn", "--status-warning-text"],
    ["bad", "--status-critical-text"],
    ["dim", "--text-tertiary"],
  ] as const) {
    expect(text).toContain(
      `.cell[data-tone="${tone}"] { color: var(${color}); }`,
    );
  }
});

test("a donut cell is a 36 px donut named by its label, in its level, with its caption beside it", () => {
  overviewTable();
  const zoneCell = cellsOf("eu-west-1a")[3] as HTMLElement;
  const zone = within(zoneCell).getByRole("img");
  expect([
    zone.getAttribute("width"),
    zone.getAttribute("aria-label"),
    zone.textContent,
    zone.parentElement?.getAttribute("data-tone"),
  ]).toEqual([
    "36",
    "eu-west-1a CPU 61%, 31.2 of 51.2 cores",
    "61%",
    "nominal",
  ]);
  expect(
    within(zoneCell).getByText("31.2 / 51.2 cores").getAttribute("aria-hidden"),
  ).toBe("true");
  expect(
    within(cellsOf("shop/web")[3] as HTMLElement)
      .getByRole("img")
      .parentElement?.getAttribute("data-tone"),
  ).toBe("critical");
  const none = within(cellsOf("none")[3] as HTMLElement).getByRole("img");
  expect([none.getAttribute("aria-label"), none.textContent]).toEqual([
    "No zone CPU: no data",
    "—",
  ]);
});

test("a row's name opens its object with a button, goes to a page with a link, or is plain text", () => {
  const onOpen = overviewTable();
  const link = screen.getByTestId("nodes-zones-open-eu-west-1a");
  expect([
    link.tagName,
    link.getAttribute("href"),
    link.getAttribute("title"),
    link.textContent,
  ]).toEqual([
    "A",
    "/cluster/c1/topology",
    "Open the Node topology",
    "eu-west-1a",
  ]);
  const button = screen.getByTestId("nodes-zones-open-shop/web");
  expect(button.tagName).toBe("BUTTON");
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(cellsOf("shop/web")[0]?.textContent).toBe("webshop");
  expect(screen.queryByTestId("nodes-zones-open-none")).toBeNull();
  const plain = screen.getByTestId("nodes-zones-row-none");
  expect(within(plain).queryByRole("button")).toBeNull();
  expect(within(plain).queryByRole("link")).toBeNull();
  expect(cellsOf("none")[0]?.textContent).toBe("No zone");
});

test("while its lists load a table reads Loading in place of its rows, without a footer", () => {
  overviewTable({ loading: true });
  expect(screen.getByTestId("nodes-zones-loading").textContent).toBe("Loading");
  expect(
    within(screen.getByTestId("nodes-zones")).getAllByRole("columnheader"),
  ).toHaveLength(4);
  expect(screen.queryByTestId("nodes-zones-row-shop/web")).toBeNull();
  expect(screen.queryByTestId("nodes-zones-footer")).toBeNull();
  expect(screen.queryByTestId("nodes-zones-empty")).toBeNull();
});

test("with no rows a table gives way to its empty state, with its icon", () => {
  overviewTable({ rows: [] });
  expect(screen.queryByTestId("nodes-zones")).toBeNull();
  expect(screen.queryByRole("heading", { name: "By zone" })).toBeNull();
  const empty = screen.getByTestId("nodes-zones-empty");
  expect(within(empty).getByRole("heading").textContent).toBe(
    "This cluster has no nodes",
  );
  expect(empty.textContent).toContain(
    "Nodes appear here once the cluster lists them.",
  );
  expect(empty.querySelector('[data-icon="server"]')).not.toBeNull();
  expect(screen.queryByTestId("nodes-zones-footer")).toBeNull();
});
