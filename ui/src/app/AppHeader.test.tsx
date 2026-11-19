import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import type { ClusterInfo } from "../ipc/generated/ClusterInfo";
import { resetCatalogForTest, useCatalog } from "../stores/catalog";
import { resetShellForTest, useShell } from "../stores/shell";
import { resetWindowLayoutForTest } from "../stores/windowLayout";
import { clusterEntry, mockBackend } from "../test/ipc";
import { AppHeader } from "./AppHeader";
import { ShellRouter } from "./tabs/ShellRouter";

vi.mock("../features/dock/openTerminal", () => ({ openTerminal: vi.fn() }));

const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: ["default"],
  namespacesRestricted: false,
  isAdmin: true,
};
const PROD = clusterEntry({
  id: "c1",
  contextName: "prod",
  state: { status: "connected", info: INFO },
});
const STAGING = clusterEntry({ id: "c2", contextName: "staging" });

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

async function show(
  entries: string[],
  clusters: ClusterEntry[] = [PROD, STAGING],
  index = entries.length - 1,
) {
  const ipc = mockBackend({
    catalog_list: () => clusters,
    catalog_warnings: () => [],
    hotbar_get: () => [],
    cluster_disconnect: () => null,
  });
  await useCatalog.getState().init();
  // The header shows the focused tab: here the only one, with this history.
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [
      {
        id: "p1",
        width: 1,
        selected: "t1",
        tabs: [{ id: "t1", pinned: false, history: entries, index }],
      },
    ],
    focusedPane: 0,
  });
  render(
    <ShellRouter>
      <AppHeader />
      <Where />
    </ShellRouter>,
  );
  return ipc;
}

function text(id: string): string | null {
  return screen.queryByTestId(id)?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCatalogForTest();
  resetShellForTest();
});

test("on the catalog: the title, the palette button and Add cluster", async () => {
  await show(["/catalog"]);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Catalog");
  expect(screen.getByTestId("app-header")).toBeTruthy();
  expect(screen.queryByTestId("connection-status")).toBeNull();
  expect(screen.queryByTestId("header-terminal")).toBeNull();
  const palette = screen.getByTestId("palette-open");
  expect(palette.getAttribute("aria-label")).toBe(
    "Command palette (Ctrl+Shift+P)",
  );
  expect(palette.getAttribute("aria-keyshortcuts")).toBe(
    "Control+Shift+P Meta+Shift+P",
  );
  expect(palette.textContent).toBe("Search or run a commandCtrl+Shift+P");

  fireEvent.click(screen.getByTestId("catalog-add"));
  expect(useShell.getState().addClusterOpen).toBe(true);
  fireEvent.click(palette);
  expect(useShell.getState().dialog).toBe("palette");
});

test("on Preferences: the title only", async () => {
  await show(["/preferences"]);

  expect(text("header-title")).toBe("Preferences");
  expect(screen.queryByTestId("catalog-add")).toBeNull();
  expect(screen.queryByTestId("connection-status")).toBeNull();
  expect(screen.queryByTestId("header-cluster-settings")).toBeNull();
});

test("a disconnected cluster: its name, badge and Cluster settings, and no other actions", async () => {
  await show(["/cluster/c2"]);

  expect(text("header-title")).toBe("Overview · staging");
  expect(text("connection-status")).toBe("Disconnected");
  for (const id of [
    "header-distribution",
    "header-terminal",
    "cluster-disconnect",
    "catalog-add",
  ]) {
    expect([id, screen.queryByTestId(id)]).toEqual([id, null]);
  }
  const settings = screen.getByTestId("header-cluster-settings");
  expect(settings.getAttribute("aria-label")).toBe("Cluster settings");
  fireEvent.click(settings);
  await waitFor(() => expect(text("where")).toBe("/cluster/c2/settings"));
});

test("the Settings route is titled Settings with the cluster's name (P9)", async () => {
  await show(["/cluster/c1/settings"]);

  expect(text("header-title")).toBe("Settings · prod");
  expect(text("connection-status")).toBe("Connected");
  expect(screen.queryByTestId("header-terminal")).toBeNull();
  fireEvent.click(screen.getByTestId("header-cluster-settings"));
  expect(text("where")).toBe("/cluster/c1/settings");
});

test("the cluster map is titled Resource map with the cluster's name", async () => {
  await show(["/cluster/c1/map"]);
  expect(text("header-title")).toBe("Resource map · prod");
});

test("an object map keeps the cluster map's title", async () => {
  await show(["/cluster/c1/map?focus=Pod%2Fshop%2Fweb&depth=1"]);
  expect(text("header-title")).toBe("Resource map · prod");
});

test("a connected cluster: the distribution and Disconnect, and no Terminal button (spec Q §4)", async () => {
  const ipc = await show(["/cluster/c1/r/core/pods"]);

  expect(text("header-title")).toBe("Pods · prod");
  expect(text("connection-status")).toBe("Connected");
  expect(text("header-distribution")).toBe("kind · v1.31.0");
  expect(screen.getByTestId("header-cluster-settings")).toBeTruthy();
  expect(screen.queryByTestId("header-terminal")).toBeNull();
  expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  fireEvent.click(screen.getByTestId("cluster-disconnect"));
  await waitFor(() =>
    expect(ipc.callsTo("cluster_disconnect")).toEqual([{ id: "c1" }]),
  );
});

test("an empty distribution reads Kubernetes", async () => {
  await show(
    ["/cluster/c1"],
    [
      clusterEntry({
        id: "c1",
        contextName: "prod",
        state: { status: "connected", info: { ...INFO, distribution: "" } },
      }),
    ],
  );

  expect(text("header-distribution")).toBe("Kubernetes · v1.31.0");
});

test("a cluster id that is not in the catalog is titled Cluster", async () => {
  await show(["/cluster/gone"]);

  expect(text("header-title")).toBe("Overview · Cluster");
});

test("back and forward move through the focused tab's history (P3)", async () => {
  await show(["/catalog", "/preferences"]);

  const back = screen.getByTestId("header-back");
  const forward = screen.getByTestId("header-forward");
  expect(back.getAttribute("aria-label")).toBe("Back (Alt+Left)");
  expect(forward.getAttribute("aria-label")).toBe("Forward (Alt+Right)");
  expect((forward as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(back);
  await waitFor(() => expect(text("where")).toBe("/catalog"));
  expect((back as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(forward);
  await waitFor(() => expect(text("where")).toBe("/preferences"));
});

test("an empty window is titled No tabs open, with Back and Forward off", async () => {
  await show(["/catalog"]);
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: "", tabs: [] }],
    focusedPane: 0,
  });
  await waitFor(() => expect(text("header-title")).toBe("No tabs open"));
  expect(
    (screen.getByTestId("header-back") as HTMLButtonElement).disabled,
  ).toBe(true);
});
