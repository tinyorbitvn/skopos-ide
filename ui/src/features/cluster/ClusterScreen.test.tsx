import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, test } from "vitest";
import { TabView } from "../../app/tabs/TabView";
import type { ConnectionLogEntry } from "../../ipc/generated/ConnectionLogEntry";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetTopologyForTest } from "../../stores/topology";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { clusterEntry, emitEvent, mockBackend } from "../../test/ipc";
import { noProvider } from "../../test/metrics";
import { ClusterOverview } from "./ClusterHome";
import { ClusterScreen } from "./ClusterScreen";

const INFO = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: ["default", "kube-system"],
  namespacesRestricted: false,
  isAdmin: true,
};

async function show(
  state: ConnectionState,
  over: Record<string, (args: never) => unknown> = {},
  id = "id-x",
) {
  const ipc = mockBackend({
    catalog_list: () => [clusterEntry({ id: "id-x", name: "x", state })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    cluster_log: () => [],
    cluster_connect: () => ({ status: "connecting" }),
    cluster_disconnect: () => null,
    resources_discover: () => [],
    metrics_provider: () => noProvider("setting"),
    node_topology_subscribe: () => "t1",
    node_topology_unsubscribe: () => null,
    ui_state_get: () => null,
    ui_state_set: () => null,
    ...over,
  });
  await useCatalog.getState().init();
  render(
    <MemoryRouter initialEntries={[`/cluster/${id}`]}>
      <Routes>
        <Route path="/cluster/:id" element={<ClusterScreen />}>
          <Route index element={<ClusterOverview />} />
        </Route>
        <Route path="/cluster/:id/settings" element={<p>settings page</p>} />
        <Route path="/catalog" element={<p>catalog page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return ipc;
}

/** Shows `path` in a tab of the window, after a Catalog tab. */
async function showInTab(path: string, pinned = false) {
  const ipc = mockBackend({
    catalog_list: () => [clusterEntry({ id: "id-x", name: "x" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    cluster_connect: () => ({ status: "connecting" }),
  });
  await useCatalog.getState().init();
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [
      {
        id: "p1",
        width: 1,
        selected: "t1",
        tabs: [
          { id: "t1", pinned, history: [path], index: 0 },
          { id: "t0", pinned: false, history: ["/catalog"], index: 0 },
        ],
      },
    ],
    focusedPane: 0,
  });
  const tab = useWindowLayout.getState().layout.panes[0].tabs[0];
  render(<TabView tab={tab} />);
  return ipc;
}

function setState(state: ConnectionState) {
  return emitEvent("cluster://state", { id: "id-x", state });
}

beforeEach(() => {
  resetCatalogForTest();
  resetTopologyForTest();
  resetMetricsForTest();
});

test("opening a disconnected cluster connects automatically", async () => {
  const ipc = await show({ status: "disconnected" });
  await waitFor(() => expect(ipc.callsTo("cluster_connect")).toHaveLength(1));
  expect(ipc.callsTo("cluster_connect")[0]).toEqual({ id: "id-x" });
});

test("shows live log lines while connecting", async () => {
  const entries: ConnectionLogEntry[] = [
    { tsMs: 1, level: "info", message: "loading kubeconfig" },
  ];
  await show({ status: "connecting" }, { cluster_log: () => [...entries] });
  const log = await screen.findByTestId("connection-log");
  await waitFor(() => expect(log.textContent).toContain("loading kubeconfig"));

  entries.push({ tsMs: 2, level: "warn", message: "dialing server" });
  await waitFor(() => expect(log.textContent).toContain("dialing server"));
});

test("failed state shows the reason, the log and Reconnect", async () => {
  const ipc = await show(
    { status: "failed", kind: "unauthorized", message: "token expired" },
    {
      cluster_log: () => [
        { tsMs: 1, level: "error", message: "401 from server" },
      ],
    },
  );
  expect(await screen.findByText("Not authorized")).toBeTruthy();
  expect(screen.getByText("token expired")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByTestId("connection-log").textContent).toContain(
      "401 from server",
    ),
  );
  expect(ipc.callsTo("cluster_connect")).toHaveLength(0);
  fireEvent.click(screen.getByTestId("cluster-reconnect"));
  await waitFor(() => expect(ipc.callsTo("cluster_connect")).toHaveLength(1));
});

test("connected state renders cluster home", async () => {
  await show({ status: "connected", info: INFO });
  expect((await screen.findByTestId("cluster-info-version")).textContent).toBe(
    "v1.31.0",
  );
  expect(screen.getByTestId("cluster-info-distribution").textContent).toBe(
    "kind",
  );
});

test("a tab whose cluster left the catalog says so, and Close closes it even pinned (P10)", async () => {
  const ipc = await showInTab("/cluster/nope", true);
  expect(
    await screen.findByText("This cluster is no longer in the catalog."),
  ).toBeTruthy();
  expect(ipc.callsTo("cluster_connect")).toEqual([]);
  fireEvent.click(screen.getByTestId("cluster-missing-close"));
  const tabs = useWindowLayout.getState().layout.panes[0].tabs;
  expect(tabs.map((t) => t.id)).toEqual(["t0"]);
});

test("a disconnect from outside the screen shows Reconnect and does not connect again", async () => {
  // The cluster was connected when the screen opened (from the hotbar), so the
  // screen made no automatic connect; the header's Disconnect is outside it.
  const ipc = await show({ status: "connected", info: INFO });
  await screen.findByTestId("cluster-info-version");

  await setState({ status: "disconnected" });

  await screen.findByTestId("cluster-reconnect");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(ipc.callsTo("cluster_connect")).toHaveLength(0);
});

test("live state events update the screen", async () => {
  await show({ status: "connecting" });
  await setState({ status: "connected", info: INFO });
  expect(await screen.findByTestId("cluster-info-version")).toBeTruthy();
});

test("a connected cluster says when it cannot list namespaces", async () => {
  await show({
    status: "connected",
    info: { ...INFO, namespaces: ["team-a"], namespacesRestricted: true },
  });
  const warning = await screen.findByTestId("cluster-namespaces-warning");
  expect(warning.textContent).toContain("team-a");
  expect(screen.getByTestId("cluster-info-namespaces").textContent).toBe(
    "Restricted",
  );
});

test("the namespace warning offers the cluster settings, and its text is unchanged", async () => {
  await show({
    status: "connected",
    info: { ...INFO, namespaces: ["team-a"], namespacesRestricted: true },
  });
  const warning = await screen.findByTestId("cluster-namespaces-warning");
  expect(warning.textContent).toBe(
    "You may not list this cluster's namespaces, so only these are used: team-a.",
  );
  fireEvent.click(screen.getByTestId("cluster-namespaces-settings"));
  expect(await screen.findByText("settings page")).toBeTruthy();
});

test("the connected Overview shows the Metrics section below the facts", async () => {
  const ipc = await show({ status: "connected", info: INFO });
  const section = await screen.findByTestId("overview-metrics");
  expect(section.querySelector("h2")?.textContent).toBe("Metrics");
  await waitFor(() =>
    expect(screen.getByTestId("metrics-note").textContent).toContain(
      "Metrics are off: the metrics provider is None in the cluster settings.",
    ),
  );
  expect(ipc.callsTo("metrics_provider")).toEqual([
    { clusterId: "id-x", refresh: false },
  ]);
  expect(screen.queryByTestId("overview-gauges")).toBeNull();
});

test("no namespace warning when namespaces can be listed", async () => {
  await show({ status: "connected", info: INFO });
  await screen.findByTestId("cluster-info-namespaces");
  expect(screen.queryByTestId("cluster-namespaces-warning")).toBeNull();
});
