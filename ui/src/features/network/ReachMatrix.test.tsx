import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CSS_FILES, cssRules } from "../../test/css";
import {
  IDS,
  paymentsSnapshot,
  rcell,
  rgroup,
  rref,
  rsnapshot,
} from "../../test/reachability";
import { ReachMatrix } from "./ReachMatrix";
import { matrixColumns, matrixRows } from "./reachModel";

const CSS = "/src/features/network/ReachMatrix.module.css";
const PAYMENTS = paymentsSnapshot();

function show(
  snapshot = PAYMENTS,
  selected: string | null = null,
  onSelect = vi.fn(),
) {
  const view = render(
    <ReachMatrix
      snapshot={snapshot}
      rows={matrixRows(snapshot, "")}
      columns={matrixColumns(snapshot, "")}
      selected={selected}
      onSelect={onSelect}
    />,
  );
  return { ...view, onSelect };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const ROWS = [
  IDS.api,
  IDS.db,
  IDS.web,
  IDS.worker,
  IDS.ingress,
  IDS.prometheus,
  IDS.otherPods,
  IDS.world,
];
const COLUMNS = [
  IDS.api,
  IDS.db,
  IDS.web,
  IDS.worker,
  IDS.coredns,
  IDS.stripe,
  IDS.otherPods,
  IDS.world,
];

test("the sample namespace's matrix reads as the board (contract C13)", () => {
  show();
  const matrix = screen.getByTestId("reach-matrix");
  expect(matrix.getAttribute("aria-label")).toBe("Connections in payments");
  expect(ROWS.map((id) => text(`reach-row-${id}`))).toEqual([
    "api6 policies",
    "db5 policies",
    "web5 policies",
    "workerNo policy",
    "ingress-nginx/ingress-nginx-controllerDeployment · 1 Pod",
    "monitoring/prometheusDeployment · 1 Pod",
    "Other Pods in the clusterPods the rules above do not name",
    "Outside the clusterAddresses the rules above do not name",
  ]);
  expect(
    within(matrix)
      .getAllByRole("columnheader")
      .map((h) => h.getAttribute("data-testid")),
  ).toEqual(COLUMNS.map((id) => `reach-col-${id}`));
  expect(
    within(matrix).getByRole("rowheader", { name: "From outside payments" }),
  ).toBeTruthy();
  expect(
    ROWS.map((from) => COLUMNS.map((to) => text(`reach-cell-${from}--${to}`))),
  ).toEqual([
    ["—", "5432", "—", "—", "53 UDP, TCP", "443", "—", "—"],
    ["—", "—", "—", "—", "53 UDP, TCP", "Denied", "—", "Denied"],
    ["8080 GET /api/.*", "—", "—", "—", "53 UDP, TCP", "—", "—", "—"],
    ["—", "—", "—", "All", "All", "All", "All", "All"],
    ["—", "—", "8080", "All", "·", "·", "·", "·"],
    ["9090", "9090", "9090", "All", "·", "·", "·", "·"],
    ["—", "—", "—", "All", "·", "·", "·", "·"],
    ["—", "—", "—", "All", "·", "·", "·", "·"],
  ]);
  expect(
    [
      `reach-cell-${IDS.web}--${IDS.api}`,
      `reach-cell-${IDS.worker}--${IDS.world}`,
      `reach-cell-${IDS.db}--${IDS.world}`,
      `reach-cell-${IDS.worker}--${IDS.web}`,
      `reach-cell-${IDS.world}--${IDS.stripe}`,
    ].map((id) => screen.getByTestId(id).getAttribute("data-verdict")),
  ).toEqual(["allowed", "open", "denied", "blocked", "none"]);
});

test("workload rows are buttons; outside rows are not selectable", () => {
  const { onSelect } = show();
  const api = screen.getByTestId(`reach-row-${IDS.api}`);
  expect([api.tagName, api.getAttribute("aria-pressed")]).toEqual([
    "BUTTON",
    "false",
  ]);
  fireEvent.click(api);
  expect(onSelect).toHaveBeenCalledWith(IDS.api);
  for (const id of [IDS.ingress, IDS.prometheus, IDS.otherPods, IDS.world]) {
    expect(screen.getByTestId(`reach-row-${id}`).tagName).toBe("SPAN");
  }
});

test("a selected workload keeps its row and column bright and fades the other cells", () => {
  show(PAYMENTS, IDS.api);
  expect(
    screen.getByTestId(`reach-row-${IDS.api}`).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen.getByTestId(`reach-col-${IDS.api}`).hasAttribute("data-selected"),
  ).toBe(true);
  const dim = (from: string, to: string) =>
    screen.getByTestId(`reach-cell-${from}--${to}`).hasAttribute("data-dim");
  expect([
    dim(IDS.api, IDS.coredns),
    dim(IDS.web, IDS.api),
    dim(IDS.api, IDS.api),
    dim(IDS.web, IDS.coredns),
    dim(IDS.ingress, IDS.web),
  ]).toEqual([false, false, false, true, true]);
});

test("nothing fades while no workload is selected", () => {
  show();
  expect(
    screen.getByTestId("reach-matrix").querySelectorAll("[data-dim]"),
  ).toHaveLength(0);
});

test("a cell's tooltip names the verdict, the ports and every policy", async () => {
  show();
  // The tooltip mounts once the pointer reaches the cell.
  expect(
    screen.getByTestId("reach-matrix").querySelectorAll("[data-state]"),
  ).toHaveLength(0);
  const cell = screen.getByTestId(`reach-cell-${IDS.web}--${IDS.api}`);
  fireEvent.pointerEnter(cell);
  fireEvent.focus(cell.querySelector("span") as HTMLElement);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    [
      "Allowed",
      "8080 GET /api/.*",
      "K8s allow-web-to-api",
      "Cilium allow-api-from-web",
    ].join(""),
  );
});

test("a catch-all cell's tooltip says the other side's policies apply too", async () => {
  show();
  const cell = screen.getByTestId(`reach-cell-${IDS.db}--${IDS.world}`);
  fireEvent.pointerEnter(cell);
  fireEvent.focus(cell.querySelector("span") as HTMLElement);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    [
      "Denied",
      "Cilium db-no-internet",
      "Policies of the other side apply too.",
    ].join(""),
  );
});

test("a cell whose Pods differ says Some Pods on a second line", () => {
  const [cart, pay] = [
    rgroup("Deployment", "shop", "cart", {
      policies: [rref("kubernetes", "a", "shop")],
    }),
    rgroup("Deployment", "shop", "pay"),
  ];
  if (cart === undefined || pay === undefined) throw new Error("no groups");
  show(
    rsnapshot("shop", [cart, pay], {
      cells: [rcell(pay.id, cart.id, "open", [], [], true)],
    }),
  );
  const cell = screen.getByTestId(`reach-cell-${pay.id}--${cart.id}`);
  expect(
    [...(cell.querySelector("span")?.children ?? [])].map((c) => c.textContent),
  ).toEqual(["All", "Some Pods"]);
  expect(
    screen.getByRole("rowheader", { name: "From outside shop" }),
  ).toBeTruthy();
});

test("the header row and the first column stay put on an opaque card", () => {
  const rules = cssRules(CSS_FILES[CSS] ?? "");
  const decls = (selector: string) =>
    rules.find((r) => r.selector.replace(/\s+/g, " ") === selector)?.decls;
  expect(decls(".corner, .colHead")).toEqual(
    expect.arrayContaining([
      ["position", "sticky"],
      ["top", "0"],
      ["background", "var(--surface-card)"],
    ]),
  );
  expect(decls(".rowHead")).toEqual(
    expect.arrayContaining([
      ["position", "sticky"],
      ["left", "0"],
      ["background", "var(--surface-card)"],
    ]),
  );
  expect(decls(".dim")).toEqual([["opacity", "0.38"]]);
});
