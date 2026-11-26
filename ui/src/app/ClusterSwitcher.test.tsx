import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { resetCatalogForTest, useCatalog } from "../stores/catalog";
import { resetFoldersForTest, useFolders } from "../stores/folders";
import { resetTunnelsForTest, useTunnels } from "../stores/tunnels";
import { CSS_FILES, cssRules } from "../test/css";
import { clusterEntry } from "../test/ipc";
import { tunnel } from "../test/tunnels";
import { ClusterSwitcher, switcherOverline } from "./ClusterSwitcher";

const INFO = {
  version: "v1",
  distribution: "kind",
  nodeCount: 1,
  namespaces: [],
  namespacesRestricted: false,
  isAdmin: true,
};

beforeEach(() => {
  resetCatalogForTest();
  resetFoldersForTest();
  resetTunnelsForTest();
  useCatalog.setState({
    loading: false,
    clusters: [
      clusterEntry({
        contextName: "prod-eu-1",
        state: { status: "connected", info: INFO },
      }),
      clusterEntry({ contextName: "prod-us-1" }),
      clusterEntry({ contextName: "demo" }),
    ],
  });
  useFolders.setState({
    loaded: true,
    folders: [
      { id: "folder-1", name: "prod", parent: null },
      { id: "folder-2", name: "eu", parent: "folder-1" },
      { id: "folder-3", name: "us", parent: "folder-1" },
    ],
    placements: { "id-prod-eu-1": "folder-2", "id-prod-us-1": "folder-3" },
  });
});

function renderSwitcher(
  clusterId: string | null,
  focused: string | null = clusterId,
) {
  const onPick = vi.fn();
  const onFollow = vi.fn();
  render(
    <ClusterSwitcher
      clusterId={clusterId}
      focused={focused}
      onPick={onPick}
      onFollow={onFollow}
    />,
  );
  return { onPick, onFollow };
}

function rows(): string[] {
  const tree = screen.getByRole("tree", { name: "Clusters by folder" });
  return within(tree)
    .getAllByRole("treeitem")
    .map((row) => row.getAttribute("aria-label") ?? "");
}

test("the switcher shows the sidebar's cluster: tile with its status dot, overline and name (P24, spec Q §2)", () => {
  renderSwitcher("id-prod-eu-1");

  const trigger = screen.getByTestId("switcher-trigger");
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.querySelector(".tile")?.textContent).toBe("PE");
  expect(
    trigger.querySelector(".tileDot [role='img']")?.getAttribute("aria-label"),
  ).toBe("Connected");
  expect(trigger.querySelector(".over")?.textContent).toBe("kind · v1");
  expect(trigger.querySelector(".name")?.textContent).toBe("prod-eu-1");
  expect(
    trigger.querySelector('[data-icon="chevrons-up-down"]'),
  ).not.toBeNull();
  expect(trigger.getAttribute("aria-label")).toBe(
    "Cluster prod-eu-1, connected. Change the cluster shown in the sidebar",
  );
  expect(trigger.getAttribute("title")).toBe(
    "prod-eu-1 · Connected. Click to show another cluster in the sidebar",
  );
});

test("with no cluster the switcher asks for one", () => {
  renderSwitcher(null);

  const trigger = screen.getByTestId("switcher-trigger");
  expect(trigger.textContent).toContain("No cluster");
  // Short enough for the overline's room in the narrowest column; the empty note under
  // the switcher says the rest.
  expect(trigger.querySelector(".over")?.textContent).toBe("Pick a cluster");
  expect(trigger.querySelector(".tileDot")).toBeNull();
  expect(trigger.getAttribute("aria-label")).toBe(
    "Cluster shown in the sidebar",
  );
  expect(trigger.getAttribute("title")).toBe("Cluster shown in the sidebar");
});

test("the list shows the clusters under their folders, each with its connection (P24)", () => {
  renderSwitcher("id-prod-eu-1");
  fireEvent.click(screen.getByTestId("switcher-trigger"));

  expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
    "Cluster shown in the sidebar",
  );
  expect(document.activeElement).toBe(screen.getByTestId("switcher-search"));
  expect(rows()).toEqual([
    "prod, 2 clusters",
    "eu, 1 cluster",
    "prod-eu-1, Connected",
    "us, 1 cluster",
    "prod-us-1, Disconnected",
    "demo, Disconnected",
  ]);
  expect(
    screen
      .getByTestId("switcher-cluster-prod-eu-1")
      .getAttribute("aria-selected"),
  ).toBe("true");

  // Folders collapse and expand.
  const prod = screen.getByTestId("switcher-folder-folder-1");
  expect(prod.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(prod);
  expect(rows()).toEqual(["prod, 2 clusters", "demo, Disconnected"]);
  fireEvent.click(prod);
  expect(rows()).toHaveLength(6);
});

test("the search matches cluster names and folder paths (P24)", () => {
  renderSwitcher("id-prod-eu-1");
  fireEvent.click(screen.getByTestId("switcher-trigger"));
  const search = screen.getByTestId("switcher-search");

  fireEvent.change(search, { target: { value: "prod / us" } });
  expect(rows()).toEqual([
    "prod, 2 clusters",
    "us, 1 cluster",
    "prod-us-1, Disconnected",
  ]);

  fireEvent.change(search, { target: { value: "dem" } });
  expect(rows()).toEqual(["demo, Disconnected"]);

  fireEvent.change(search, { target: { value: "nothing" } });
  expect(screen.getByText("No cluster or folder matches.")).toBeTruthy();
});

test("picking a cluster hands it over and closes the list", () => {
  const { onPick } = renderSwitcher("id-prod-eu-1");
  fireEvent.click(screen.getByTestId("switcher-trigger"));

  fireEvent.click(screen.getByTestId("switcher-cluster-demo"));

  expect(onPick).toHaveBeenCalledWith("id-demo");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Enter in the search picks the first cluster that matches", () => {
  const { onPick } = renderSwitcher("id-prod-eu-1");
  fireEvent.click(screen.getByTestId("switcher-trigger"));
  const search = screen.getByTestId("switcher-search");

  fireEvent.change(search, { target: { value: "us" } });
  fireEvent.keyDown(search, { key: "Enter" });

  expect(onPick).toHaveBeenCalledWith("id-prod-us-1");
});

test("Escape and a press outside close the list", () => {
  renderSwitcher("id-prod-eu-1");
  const trigger = screen.getByTestId("switcher-trigger");

  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByTestId("switcher-search"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("while the sidebar shows another cluster, a line offers the focused tab's (P25)", () => {
  const { onFollow } = renderSwitcher("id-demo", "id-prod-eu-1");

  expect(screen.getByTestId("switcher-follow").textContent).toContain(
    "The focused tab is on prod-eu-1.",
  );
  const show = screen.getByTestId("switcher-follow-show");
  expect(show.textContent).toBe("Show prod-eu-1");
  fireEvent.click(show);
  expect(onFollow).toHaveBeenCalled();
});

test("no line while the sidebar follows the focused tab, or on a tab without a cluster", () => {
  renderSwitcher("id-prod-eu-1", "id-prod-eu-1");
  expect(screen.getByTestId("switcher-trigger").textContent).toContain(
    "prod-eu-1",
  );
  expect(screen.queryByTestId("switcher-follow")).toBeNull();
  cleanup();

  renderSwitcher("id-demo", null);
  expect(screen.queryByTestId("switcher-follow")).toBeNull();
});

test("the overline reads the distribution and version, or the state word", () => {
  const connected = (
    distribution: string,
    version: string,
  ): ConnectionState => ({
    status: "connected",
    info: { ...INFO, distribution, version },
  });
  expect(switcherOverline(connected("kind", "v1.31.0"))).toBe("kind · v1.31.0");
  expect(switcherOverline(connected("", "v1.31.0"))).toBe(
    "Kubernetes · v1.31.0",
  );
  expect(switcherOverline(connected("  ", "v1.31.0"))).toBe(
    "Kubernetes · v1.31.0",
  );
  expect(switcherOverline(connected("eks", ""))).toBe("eks");
  // Build metadata after "+" would push the version out of the overline's room.
  expect(switcherOverline(connected("rke2", "v1.37.0+rke2r1"))).toBe(
    "rke2 · v1.37.0",
  );
  expect(switcherOverline({ status: "disconnected" })).toBe("Disconnected");
  expect(switcherOverline({ status: "connecting" })).toBe("Connecting");
  expect(
    switcherOverline({ status: "failed", kind: "unreachable", message: "x" }),
  ).toBe("Failed");

  useCatalog.setState({
    clusters: [
      clusterEntry({
        contextName: "bare",
        state: { status: "connected", info: { ...INFO, distribution: "" } },
      }),
      clusterEntry({ contextName: "idle" }),
    ],
  });
  renderSwitcher("id-bare");
  expect(
    screen.getByTestId("switcher-trigger").querySelector(".over")?.textContent,
  ).toBe("Kubernetes · v1");
  cleanup();
  renderSwitcher("id-idle");
  const idle = screen.getByTestId("switcher-trigger");
  expect(idle.querySelector(".over")?.textContent).toBe("Disconnected");
  expect(idle.getAttribute("aria-label")).toBe(
    "Cluster idle, disconnected. Change the cluster shown in the sidebar",
  );
});

test("the trigger and its menu have the design's metrics and open look (spec Q §2)", () => {
  const rules = cssRules(CSS_FILES["/src/app/ClusterSwitcher.module.css"]);
  const decl = (selector: string, prop: string) =>
    rules
      .find((r) => r.selector === selector)
      ?.decls.find(([p]) => p === prop)?.[1];
  expect([
    decl(".switcher", "padding"),
    decl(".trigger", "height"),
    decl(".trigger", "gap"),
    decl(".trigger", "padding"),
    decl(".trigger", "border"),
    decl(".trigger", "background"),
    decl(".trigger", "border-radius"),
    decl(".trigger:hover", "background"),
    decl('.trigger[aria-expanded="true"]', "border-color"),
    decl('.trigger[aria-expanded="true"]', "background"),
  ]).toEqual([
    "var(--space-6) var(--space-6) var(--space-4)",
    "52px",
    "var(--space-6)",
    "0 var(--space-5) 0 var(--space-4)",
    "1px solid transparent",
    "transparent",
    "var(--radius-md)",
    "var(--surface-hover)",
    "var(--border-accent)",
    "var(--glass-field)",
  ]);
  expect([
    decl(".tile", "width"),
    decl(".tile", "height"),
    decl(".tile", "border-radius"),
    decl(".tileDot", "right"),
    decl(".tileDot", "bottom"),
    decl(".tileDot", "border"),
    decl(".over", "text-transform"),
    decl(".name", "font-size"),
    decl(".name", "font-weight"),
    decl(".name", "text-overflow"),
  ]).toEqual([
    "36px",
    "36px",
    "var(--radius-sm)",
    "-3px",
    "-3px",
    "2px solid var(--surface-card)",
    "uppercase",
    "14px",
    "var(--weight-semibold)",
    undefined,
  ]);
  expect(
    rules.find(
      (r) => r.selector.includes(".name") && r.selector.includes(".over"),
    )?.decls,
  ).toContainEqual(["text-overflow", "ellipsis"]);
  // The design's head: initials in label type, 2px between the overline and the name.
  expect([decl(".tile", "font"), decl(".text", "gap")]).toEqual([
    "var(--type-label)",
    "var(--space-2)",
  ]);
  // The menu sits 66px down and 8px in from the top of the switcher, padded 6px.
  expect([
    decl(".panel", "top"),
    decl(".panel", "left"),
    decl(".panel", "padding"),
    decl(".panel", "width"),
    decl('.switcher[data-collapsed="true"] .panel', "top"),
    decl('.switcher[data-collapsed="true"] .panel', "left"),
    decl('.switcher[data-collapsed="true"] .trigger', "width"),
    decl('.switcher[data-collapsed="true"] .trigger', "height"),
    decl('.switcher[data-collapsed="true"] .text', "display"),
    decl('.switcher[data-collapsed="true"] .updown', "display"),
  ]).toEqual([
    "66px",
    "var(--space-5)",
    "var(--space-4)",
    "272px",
    "var(--space-5)",
    "calc(100% + 6px)",
    "48px",
    "48px",
    "none",
    "none",
  ]);
});

test("collapsed, the switcher is the tile alone, named in a tooltip on the right, with no follow line", async () => {
  render(
    <ClusterSwitcher
      clusterId="id-prod-eu-1"
      focused="id-demo"
      onPick={vi.fn()}
      onFollow={vi.fn()}
      collapsed
    />,
  );
  const trigger = screen.getByTestId("switcher-trigger");
  expect(
    trigger.closest("[data-collapsed]")?.getAttribute("data-collapsed"),
  ).toBe("true");
  expect(trigger.getAttribute("title")).toBeNull();
  expect(trigger.getAttribute("aria-label")).toBe(
    "Cluster prod-eu-1, connected. Change the cluster shown in the sidebar",
  );
  expect(screen.queryByTestId("switcher-follow")).toBeNull();
  fireEvent.focus(trigger);
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe("prod-eu-1");
  expect(
    document
      .querySelector("[data-radix-popper-content-wrapper] > *")
      ?.getAttribute("data-side"),
  ).toBe("right");
  fireEvent.click(trigger);
  expect(screen.getByTestId("switcher-menu")).toBeTruthy();
});

test("collapsing closes the open menu", () => {
  const props = {
    clusterId: "id-prod-eu-1",
    focused: "id-prod-eu-1",
    onPick: vi.fn(),
    onFollow: vi.fn(),
  };
  const { rerender } = render(<ClusterSwitcher {...props} />);
  fireEvent.click(screen.getByTestId("switcher-trigger"));
  expect(screen.getByTestId("switcher-menu")).toBeTruthy();
  rerender(<ClusterSwitcher {...props} collapsed />);
  expect(screen.queryByTestId("switcher-menu")).toBeNull();
  rerender(<ClusterSwitcher {...props} />);
  expect(screen.queryByTestId("switcher-menu")).toBeNull();
});

test("a connected cluster whose tunnel failed reads Tunnel failed in the list", () => {
  useTunnels.setState({
    tunnels: [tunnel({ state: { status: "failed", message: "refused" } })],
  });
  useCatalog.setState({
    clusters: useCatalog
      .getState()
      .clusters.map((c) =>
        c.contextName === "prod-eu-1" ? { ...c, tunnel: "t1" } : c,
      ),
  });
  renderSwitcher("id-prod-eu-1");
  fireEvent.click(screen.getByTestId("switcher-trigger"));
  const row = screen.getByTestId("switcher-cluster-prod-eu-1");
  expect(row.getAttribute("aria-label")).toBe("prod-eu-1, Tunnel failed");
  expect(within(row).getByText("Tunnel failed").getAttribute("title")).toBe(
    'Tunnel "corp": refused',
  );
});
