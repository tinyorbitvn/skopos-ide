import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetCatalogForTest, useCatalog } from "../stores/catalog";
import { resetFoldersForTest, useFolders } from "../stores/folders";
import { clusterEntry } from "../test/ipc";
import { ClusterSwitcher } from "./ClusterSwitcher";

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

test("the switcher shows the sidebar's cluster: tile, name and state (P24)", () => {
  renderSwitcher("id-prod-eu-1");

  const trigger = screen.getByTestId("switcher-trigger");
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.textContent).toContain("PE");
  expect(trigger.textContent).toContain("prod-eu-1");
  expect(trigger.textContent).toContain("Connected");
});

test("with no cluster the switcher asks for one", () => {
  renderSwitcher(null);

  expect(screen.getByTestId("switcher-trigger").textContent).toContain(
    "No cluster",
  );
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
