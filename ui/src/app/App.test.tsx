import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { events } from "../ipc/events";
import type { TabState } from "../ipc/generated/TabState";
import type { WindowLayout } from "../ipc/generated/WindowLayout";
import { resetCatalogForTest } from "../stores/catalog";
import { resetShellForTest } from "../stores/shell";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../stores/windowLayout";
import { clusterEntry, emitEvent, mockBackend } from "../test/ipc";
import { App } from "./App";
import { focusedTab } from "./tabs/layout";

const INFO = {
  version: "v1",
  distribution: "kind",
  nodeCount: 1,
  namespaces: [],
  namespacesRestricted: false,
  isAdmin: true,
};

function tab(
  id: string,
  history: string[],
  index = history.length - 1,
): TabState {
  return { id, pinned: false, history, index };
}

function windowOf(tabs: TabState[][], focusedPane = 0): WindowLayout {
  return {
    label: "main",
    bounds: null,
    panes: tabs.map((paneTabs, i) => ({
      id: `p${i + 1}`,
      width: 1 / tabs.length,
      selected: paneTabs[0]?.id ?? "",
      tabs: paneTabs,
    })),
    focusedPane,
  };
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
  resetWindowLayoutForTest();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  resetWindowLayoutForTest();
});

test("renders the app root and opens the catalog by default", async () => {
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });

  render(<App />);

  expect(screen.getByTestId("app-root")).toBeTruthy();
  expect(await screen.findByTestId("catalog-row-alpha")).toBeTruthy();
  expect(screen.getByTestId("hotbar")).toBeTruthy();
  expect(window.location.hash).toBe("#/catalog");
});

test("the status bar names the focused tab and the app version (P4)", async () => {
  mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: { status: "connected", info: INFO },
      }),
      clusterEntry({ contextName: "beta" }),
    ],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });

  render(<App />);

  expect(await screen.findByText(/0\.1\.0/)).toBeTruthy();
  expect(screen.getByTestId("status-focused").textContent).toBe("Catalog");
  expect(screen.getByTestId("status-layout").textContent).toBe(
    "1 pane · 1 tab",
  );
  expect(screen.getByTestId("status-bar").textContent).not.toContain(
    "connected",
  );
});

test("the window shows the layout the core keeps, with this window's panes (P38)", async () => {
  const backend = mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    prefs_get: () => ({ theme: "system", syncSources: [] }),
    window_layout_get: () =>
      windowOf([[tab("t1", ["/catalog"])], [tab("t2", ["/preferences"])]], 1),
    window_layout_set: () => null,
  });

  render(<App />);

  expect(await screen.findByTestId("pane-1")).toBeTruthy();
  expect(await screen.findByTestId("catalog-row-alpha")).toBeTruthy();
  expect(screen.getByTestId("header-title").textContent).toBe("Preferences");
  expect(window.location.hash).toBe("#/preferences");
  expect(backend.callsTo("window_layout_set")).toEqual([]);
});

test("tabs the routes do not know are dropped and the result sent back (P39)", async () => {
  const backend = mockBackend({
    catalog_list: () => [],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    window_layout_get: () =>
      windowOf([[tab("t1", ["/workspace"]), tab("t2", ["/catalog"])]]),
    window_layout_set: () => null,
  });

  render(<App />);

  await waitFor(() =>
    expect(backend.callsTo("window_layout_set")).toHaveLength(1),
  );
  const [{ layout }] = backend.callsTo("window_layout_set") as {
    layout: WindowLayout;
  }[];
  expect(layout.panes[0].tabs.map((t) => t.id)).toEqual(["t2"]);
  expect(screen.queryByTestId("tab-t1")).toBeNull();
  expect(await screen.findByTestId("tab-t2")).toBeTruthy();
});

test("a window whose tabs cannot load says so, saves nothing, and Try again shows the panes", async () => {
  const backend = mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    window_layout_get: () => windowOf([[tab("t1", ["/catalog"])]]),
    window_layout_set: () => null,
  });
  useWindowLayout.setState({ ready: false });
  const listenSpy = vi
    .spyOn(events, "onWindowLayout")
    .mockRejectedValueOnce(new Error("no event channel"));
  try {
    render(<App />);

    expect(
      await screen.findByText("Could not load this window's tabs."),
    ).toBeTruthy();
    expect(screen.getByText("no event channel")).toBeTruthy();
    expect(screen.queryByText("Loading")).toBeNull();
    expect(screen.queryByTestId("tab-t1")).toBeNull();
    expect(backend.callsTo("window_layout_get")).toEqual([]);
    expect(backend.callsTo("window_layout_set")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("tab-t1")).toBeTruthy();
    expect(screen.queryByText("Could not load this window's tabs.")).toBeNull();
    expect(backend.callsTo("window_layout_set")).toEqual([]);
    await waitFor(() => expect(window.location.hash).toBe("#/catalog"));
  } finally {
    listenSpy.mockRestore();
  }
});

test("the main window without tabs shows the empty state (P21)", async () => {
  mockBackend({
    catalog_list: () => [],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    window_layout_get: () => windowOf([[]]),
    window_layout_set: () => null,
  });

  render(<App />);

  expect(await screen.findByTestId("pane-empty")).toBeTruthy();
  expect(screen.getByTestId("header-title").textContent).toBe("No tabs open");
  expect(window.location.hash).toBe("");
});

test("Back and Forward in the header move the focused tab's own history (P3)", async () => {
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    prefs_get: () => ({ theme: "system", syncSources: [] }),
    window_layout_get: () =>
      windowOf([
        [tab("t1", ["/catalog", "/preferences"], 1)],
        [tab("t2", ["/catalog"])],
      ]),
    window_layout_set: () => null,
  });

  render(<App />);
  await screen.findByTestId("pane-1");
  const back = screen.getByTestId("header-back") as HTMLButtonElement;
  const forward = screen.getByTestId("header-forward") as HTMLButtonElement;
  expect(forward.disabled).toBe(true);
  fireEvent.click(back);
  await waitFor(() =>
    expect(focusedTab(useWindowLayout.getState().layout)?.index).toBe(0),
  );
  expect(screen.getByTestId("header-title").textContent).toBe("Catalog");
  // The other pane's tab did not move.
  const other = useWindowLayout.getState().layout.panes[1].tabs[0];
  expect(other.index).toBe(0);
  await waitFor(() => expect(forward.disabled).toBe(false));
});

test("the sidebar shows the focused tab's cluster, and keeps it on a Catalog tab (P23)", async () => {
  mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: { status: "connected", info: INFO },
      }),
    ],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    resources_discover: () => [],
    ui_state_get: () => null,
    ui_state_set: () => null,
    window_layout_get: () =>
      windowOf([[tab("t1", ["/catalog"])], [tab("t2", ["/cluster/id-alpha"])]]),
    window_layout_set: () => null,
  });

  render(<App />);

  // A Catalog tab with no cluster shown before: no cluster navigation.
  expect(await screen.findByTestId("sidebar-empty")).toBeTruthy();
  act(() =>
    useWindowLayout.getState().dispatch({ type: "focusPane", paneId: "p2" }),
  );
  expect(await screen.findByTestId("cluster-sidebar")).toBeTruthy();
  expect(screen.getByTestId("nav-resize")).toBeTruthy();
  act(() =>
    useWindowLayout.getState().dispatch({ type: "focusPane", paneId: "p1" }),
  );
  expect(screen.getByTestId("cluster-sidebar")).toBeTruthy();
  expect(screen.queryByTestId("sidebar-empty")).toBeNull();
});

test("a cluster picked in the switcher shows in the sidebar until focus moves to another tab (P24, P25)", async () => {
  const backend = mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: { status: "connected", info: INFO },
      }),
      clusterEntry({ contextName: "beta" }),
    ],
    catalog_warnings: () => [],
    catalog_folders: () => ({
      folders: [{ id: "folder-1", name: "prod", parent: null }],
      placements: { "id-beta": "folder-1" },
    }),
    cluster_connect: () => null,
    hotbar_get: () => [],
    resources_discover: () => [],
    ui_state_get: () => null,
    ui_state_set: () => null,
    window_layout_get: () =>
      windowOf([
        [tab("t1", ["/cluster/id-alpha"])],
        [tab("t2", ["/cluster/id-alpha/map"])],
      ]),
    window_layout_set: () => null,
  });

  render(<App />);
  expect(await screen.findByTestId("cluster-sidebar")).toBeTruthy();
  const before = useWindowLayout.getState().layout;

  fireEvent.click(screen.getByTestId("switcher-trigger"));
  fireEvent.click(await screen.findByTestId("switcher-cluster-beta"));

  // Only the sidebar changed; beta is not connected, so it connects.
  expect(await screen.findByTestId("sidebar-waiting")).toBeTruthy();
  expect(backend.callsTo("cluster_connect")).toEqual([{ id: "id-beta" }]);
  expect(useWindowLayout.getState().layout).toBe(before);
  expect(screen.getByTestId("switcher-follow").textContent).toContain(
    "The focused tab is on alpha.",
  );

  fireEvent.click(screen.getByTestId("switcher-follow-show"));
  expect(await screen.findByTestId("cluster-sidebar")).toBeTruthy();
  expect(screen.queryByTestId("switcher-follow")).toBeNull();

  // A pick lasts until focus moves to another tab.
  fireEvent.click(screen.getByTestId("switcher-trigger"));
  fireEvent.click(await screen.findByTestId("switcher-cluster-beta"));
  expect(await screen.findByTestId("sidebar-waiting")).toBeTruthy();
  act(() =>
    useWindowLayout.getState().dispatch({ type: "focusPane", paneId: "p2" }),
  );
  expect(await screen.findByTestId("cluster-sidebar")).toBeTruthy();
  expect(screen.queryByTestId("switcher-follow")).toBeNull();
});

test("a pick is dropped when the focused tab moves to another pane (P25)", async () => {
  mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: { status: "connected", info: INFO },
      }),
      clusterEntry({ contextName: "beta" }),
    ],
    catalog_warnings: () => [],
    catalog_folders: () => ({ folders: [], placements: {} }),
    cluster_connect: () => null,
    hotbar_get: () => [],
    resources_discover: () => [],
    ui_state_get: () => null,
    ui_state_set: () => null,
    window_layout_get: () =>
      windowOf([
        [tab("t1", ["/cluster/id-alpha"])],
        [tab("t2", ["/cluster/id-alpha/map"])],
      ]),
    window_layout_set: () => null,
  });

  render(<App />);
  expect(await screen.findByTestId("cluster-sidebar")).toBeTruthy();

  fireEvent.click(screen.getByTestId("switcher-trigger"));
  fireEvent.click(await screen.findByTestId("switcher-cluster-beta"));
  expect(await screen.findByTestId("sidebar-waiting")).toBeTruthy();

  // The focused tab keeps its id and cluster but moves to the other pane.
  act(() =>
    useWindowLayout.getState().dispatch({
      type: "move",
      tabId: "t1",
      paneId: "p2",
      index: 0,
    }),
  );
  expect(focusedTab(useWindowLayout.getState().layout)?.id).toBe("t1");
  expect(await screen.findByTestId("cluster-sidebar")).toBeTruthy();
  expect(screen.queryByTestId("switcher-follow")).toBeNull();
});

test("a sidebar item navigates the focused tab, and Ctrl+click opens a new tab (P11, P12)", async () => {
  mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: { status: "connected", info: INFO },
      }),
    ],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    resources_discover: () => [],
    ui_state_get: () => null,
    ui_state_set: () => null,
    port_forward_list: () => [],
    window_layout_get: () => windowOf([[tab("t1", ["/cluster/id-alpha/map"])]]),
    window_layout_set: () => null,
  });

  render(<App />);
  const item = await screen.findByTestId("nav-port-forwards");
  fireEvent.click(item);
  await waitFor(() =>
    expect(window.location.hash).toBe("#/cluster/id-alpha/port-forwards"),
  );
  let tabs = useWindowLayout.getState().layout.panes[0].tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0].history).toEqual([
    "/cluster/id-alpha/map",
    "/cluster/id-alpha/port-forwards",
  ]);

  fireEvent.click(await screen.findByTestId("nav-map"), { ctrlKey: true });
  tabs = useWindowLayout.getState().layout.panes[0].tabs;
  expect(tabs.map((t) => t.history[t.index])).toEqual([
    "/cluster/id-alpha/port-forwards",
    "/cluster/id-alpha/map",
  ]);
});

test("a cluster location in the hash renders the cluster's name (P5)", async () => {
  window.history.replaceState(null, "", "/#/cluster/id-alpha");
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });

  render(<App />);

  // The header title is the focused tab's: its screen and cluster (P3, P9).
  expect(
    await screen.findByRole("heading", { name: "Overview · alpha" }),
  ).toBeTruthy();
  expect(window.location.hash).toBe("#/cluster/id-alpha");
});

test("the port forwards route shows its screen with the sidebar entry active", async () => {
  window.history.replaceState(null, "", "/#/cluster/id-alpha/port-forwards");
  mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: {
          status: "connected",
          info: {
            version: "v1",
            distribution: "kind",
            nodeCount: 1,
            namespaces: [],
            namespacesRestricted: false,
            isAdmin: true,
          },
        },
      }),
    ],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    resources_discover: () => [],
    ui_state_get: () => null,
    ui_state_set: () => null,
  });

  render(<App />);

  expect(await screen.findByTestId("port-forwards-screen")).toBeTruthy();
  const link = await screen.findByTestId("nav-port-forwards");
  expect(link.getAttribute("aria-current")).toBe("page");
});

test("Ctrl+, opens Preferences from a text field", async () => {
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    prefs_get: () => ({ theme: "system", syncSources: [] }),
  });

  render(<App />);
  await screen.findByTestId("catalog-row-alpha");
  fireEvent.keyDown(screen.getByTestId("catalog-search"), {
    key: ",",
    code: "Comma",
    ctrlKey: true,
  });

  await waitFor(() => expect(window.location.hash).toBe("#/preferences"));
});

test("Ctrl+Shift+P opens the palette from a text field", async () => {
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });

  render(<App />);
  await screen.findByTestId("catalog-row-alpha");
  fireEvent.keyDown(screen.getByTestId("catalog-search"), {
    key: "P",
    code: "KeyP",
    ctrlKey: true,
    shiftKey: true,
  });

  expect(
    await screen.findByRole("dialog", { name: "Command palette" }),
  ).toBeTruthy();
});

test("the tab keys act on this window's layout: Ctrl+\\, Ctrl+Tab and Ctrl+W (P16)", async () => {
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    prefs_get: () => ({ theme: "system", syncSources: [] }),
    window_layout_get: () =>
      windowOf([[tab("t1", ["/catalog"]), tab("t2", ["/preferences"])]]),
    window_layout_set: () => null,
  });

  render(<App />);
  await screen.findByTestId("catalog-row-alpha");
  const search = screen.getByTestId("catalog-search");
  fireEvent.keyDown(search, { key: "\\", code: "Backslash", ctrlKey: true });
  expect(await screen.findByTestId("pane-1")).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Tab", code: "Tab", ctrlKey: true });
  expect(focusedTab(useWindowLayout.getState().layout)?.history).toEqual([
    "/catalog",
  ]);
  fireEvent.keyDown(document.body, { key: "w", code: "KeyW", ctrlKey: true });
  await waitFor(() => expect(screen.queryByTestId("pane-1")).toBeNull());
  expect(useWindowLayout.getState().layout.panes[0].tabs).toHaveLength(2);
});

test("menu commands open the dialogs and Preferences", async () => {
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    prefs_get: () => ({ theme: "system", syncSources: [] }),
    app_info: () => {
      throw { code: "Internal", message: "no facts", details: null };
    },
  });

  render(<App />);
  await screen.findByTestId("catalog-row-alpha");

  await emitEvent("menu://command", { id: "shortcuts" });
  expect(
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeTruthy();

  await emitEvent("menu://command", { id: "about" });
  expect(
    await screen.findByRole("dialog", { name: "About SkoposIDE" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeNull();

  await emitEvent("menu://command", { id: "palette" });
  expect(
    await screen.findByRole("dialog", { name: "Command palette" }),
  ).toBeTruthy();

  await emitEvent("menu://command", { id: "preferences" });
  await waitFor(() => expect(window.location.hash).toBe("#/preferences"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
