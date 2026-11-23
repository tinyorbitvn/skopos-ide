import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { clusterEntry, mockBackend } from "../../test/ipc";
import { AgentChangesSection } from "./AgentChangesSection";

const SETTINGS = {
  changes: "ask",
  namespaces: null,
  secretValues: false,
  exec: false,
  defaultAgent: null,
  notes: "",
};

beforeEach(() => resetCatalogForTest());

async function show(more: Parameters<typeof mockBackend>[0] = {}) {
  const ipc = mockBackend({
    catalog_list: () => [
      clusterEntry({ id: "a", contextName: "prod-eu-west" }),
      clusterEntry({ id: "b", contextName: "kind-e2e" }),
    ],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    cluster_agent_settings: ({ id }: { id: string }) =>
      id === "b" ? { ...SETTINGS, changes: "readOnly" } : SETTINGS,
    cluster_agent_changes_set: () => null,
    ...more,
  });
  await useCatalog.getState().init();
  render(<AgentChangesSection />);
  return ipc;
}

test("each cluster shows its saved setting", async () => {
  await show();
  const b = await screen.findByTestId("pref-changes-b");
  await waitFor(() =>
    expect(
      (within(b).getByRole("radio", { name: "Read only" }) as HTMLInputElement)
        .checked,
    ).toBe(true),
  );
});

test("Don't ask on a prod cluster saves at once and warns", async () => {
  const ipc = await show();
  const a = await screen.findByTestId("pref-changes-a");
  fireEvent.click(within(a).getByRole("radio", { name: "Don't ask" }));
  await waitFor(() =>
    expect(ipc.callsTo("cluster_agent_changes_set")).toEqual([
      { id: "a", changes: "dontAsk" },
    ]),
  );
  expect(
    await screen.findByText(
      "Changes to prod-eu-west will run without asking you.",
    ),
  ).toBeTruthy();
});

test("no clusters reads No clusters yet", async () => {
  mockBackend({
    catalog_list: () => [],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });
  await useCatalog.getState().init();
  render(<AgentChangesSection />);
  expect(await screen.findByText("No clusters yet")).toBeTruthy();
});
