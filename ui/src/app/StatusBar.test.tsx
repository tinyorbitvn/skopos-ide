import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import {
  resetUpdatesForTest,
  useUpdates,
} from "../features/updates/updateStore";
import type { PortForward } from "../ipc/generated/PortForward";
import type { TabState } from "../ipc/generated/TabState";
import { resetCatalogForTest, useCatalog } from "../stores/catalog";
import {
  resetPortForwardsForTest,
  usePortForwards,
} from "../stores/portForwards";
import { resetShellForTest, useShell } from "../stores/shell";
import { resetWindowLayoutForTest } from "../stores/windowLayout";
import { clusterEntry, flush, mockBackend } from "../test/ipc";
import { forward } from "../test/portForwards";
import { RELEASE, updateState } from "../test/updates";
import { StatusBar } from "./StatusBar";

function tab(id: string, path: string): TabState {
  return { id, pinned: false, history: [path], index: 0 };
}

beforeEach(() => {
  resetUpdatesForTest();
  resetShellForTest();
  resetCatalogForTest();
  resetPortForwardsForTest();
  resetWindowLayoutForTest();
  mockBackend({});
});

async function show(forwards: PortForward[]): Promise<void> {
  usePortForwards.setState({ forwards, loaded: true });
  render(<StatusBar />);
  await act(flush);
}

test.each<[string, PortForward[], string | null]>([
  [
    "none running",
    [forward({ id: "a" }), forward({ id: "b", state: "starting" })],
    null,
  ],
  [
    "one running",
    [
      forward({ id: "a", state: "running" }),
      forward({ id: "b", state: "failed" }),
    ],
    "1 port forward running",
  ],
  [
    "two running in two clusters",
    [
      forward({ id: "a", state: "running" }),
      forward({ id: "b", state: "running", clusterId: "c2" }),
    ],
    "2 port forwards running",
  ],
])("with %s, the status bar reads %j", async (_, forwards, text) => {
  await show(forwards);
  const item = screen.queryByTestId("status-port-forwards");
  if (text === null) expect(item).toBeNull();
  else expect(item?.textContent).toBe(text);
});

test("the focused screen, the port forwards, then the panes, tabs and version (P4)", async () => {
  await show([forward({ id: "a", state: "running" })]);
  expect(
    Array.from(screen.getByTestId("status-bar").children).map(
      (child) => child.textContent,
    ),
  ).toEqual([
    "Catalog",
    "1 port forward running",
    "1 pane · 1 tabSkoposIDE 0.1.0",
  ]);
});

test("names the focused tab's cluster and its connection state", async () => {
  useCatalog.setState({
    clusters: [
      clusterEntry({
        id: "c1",
        contextName: "prod",
        state: { status: "connecting" },
      }),
    ],
  });
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [
      { id: "p1", width: 0.5, selected: "t1", tabs: [tab("t1", "/catalog")] },
      {
        id: "p2",
        width: 0.5,
        selected: "t2",
        tabs: [tab("t2", "/cluster/c1/map"), tab("t3", "/preferences")],
      },
    ],
    focusedPane: 1,
  });
  await show([]);
  expect(screen.getByTestId("status-focused").textContent).toBe(
    "prod · Connecting",
  );
  expect(screen.getByTestId("status-layout").textContent).toBe(
    "2 panes · 3 tabs",
  );
});

test("an empty window says so", async () => {
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: "", tabs: [] }],
    focusedPane: 0,
  });
  await show([]);
  expect(screen.getByTestId("status-focused").textContent).toBe("No tabs open");
  expect(screen.getByTestId("status-layout").textContent).toBe(
    "1 pane · 0 tabs",
  );
});

test("the count follows the store", async () => {
  await show([forward({ id: "a", state: "running" })]);
  act(() => usePortForwards.setState({ forwards: [forward({ id: "a" })] }));
  expect(screen.queryByTestId("status-port-forwards")).toBeNull();
});

const available = updateState({
  phase: { type: "available", release: RELEASE },
});

test("without an update the right side ends with the version", async () => {
  await show([]);
  expect(screen.getByTestId("status-version").textContent).toBe(
    "SkoposIDE 0.1.0",
  );
  expect(screen.queryByTestId("status-update")).toBeNull();
});

test("an offered release replaces the version with a button that opens the dialog", async () => {
  useUpdates.setState({ state: available });
  await show([]);
  expect(screen.queryByTestId("status-version")).toBeNull();
  const button = screen.getByTestId("status-update");
  expect(button.textContent).toBe("Update to 0.10.0");
  fireEvent.click(button);
  expect(useShell.getState().dialog).toBe("updates");
});

test("a skipped release keeps the version, and a newer one brings the button back", async () => {
  useUpdates.setState({ state: { ...available, skipped: "0.10.0" } });
  await show([]);
  expect(screen.getByTestId("status-version").textContent).toBe(
    "SkoposIDE 0.1.0",
  );
  act(() =>
    useUpdates.setState({
      state: {
        ...available,
        skipped: "0.10.0",
        phase: {
          type: "available",
          release: { ...RELEASE, version: "0.11.0" },
        },
      },
    }),
  );
  expect(screen.getByTestId("status-update").textContent).toBe(
    "Update to 0.11.0",
  );
});

test("a download shows its share in the status bar", async () => {
  useUpdates.setState({
    state: updateState({
      phase: {
        type: "downloading",
        version: "0.10.0",
        received: 6_720_000,
        total: 16_000_000,
      },
    }),
  });
  await show([]);
  expect(screen.getByTestId("status-update").textContent).toBe(
    "Downloading 0.10.0 · 42%",
  );
});
