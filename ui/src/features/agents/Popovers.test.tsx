import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetAgentsForTest } from "../../stores/agents";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { clusterEntry, mockBackend } from "../../test/ipc";
import { AgentPopover } from "./AgentPopover";
import { ScopePopover } from "./ScopePopover";

const PAGE = {
  id: "a",
  name: "prod-eu-west",
  state: { status: "disconnected" as const },
};

beforeEach(() => {
  resetCatalogForTest();
  resetAgentsForTest();
  useCatalog.setState({
    clusters: [
      clusterEntry({ id: "a", name: "prod-eu-west" }),
      clusterEntry({ id: "b", name: "kind-e2e" }),
      clusterEntry({ id: "c", name: "staging" }),
    ],
  });
});

test("This cluster picks the page's cluster and closes", () => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <ScopePopover
      scope={{ clusters: ["a", "b"], global: true }}
      page={PAGE}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  const pop = screen.getByRole("dialog", { name: "Scope" });
  // The page's name shows in the "This cluster" row and in the cluster list (same catalog name).
  expect(
    within(pop).getAllByText("prod-eu-west", { selector: "span" }).length,
  ).toBeGreaterThan(0);
  fireEvent.click(within(pop).getByTestId("agent-scope-this"));
  expect(onPick).toHaveBeenCalledWith({ clusters: ["a"], global: false });
  expect(onClose).toHaveBeenCalled();
});

test("checkboxes start a new chat each time, stay open, and keep one cluster", () => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <ScopePopover
      scope={{ clusters: ["b"], global: true }}
      page={null}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  expect(screen.queryByTestId("agent-scope-this")).toBeNull();
  const b = screen.getByTestId("agent-scope-cluster-b") as HTMLInputElement;
  expect(b.checked).toBe(true);
  expect(b.disabled).toBe(true);
  fireEvent.click(screen.getByTestId("agent-scope-cluster-c"));
  expect(onPick).toHaveBeenCalledWith({ clusters: ["b", "c"], global: true });
  expect(onClose).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      "A chat across clusters can read every cluster you check. Changes still ask you first.",
    ),
  ).toBeTruthy();
});

test("Escape closes the popover and goes no further", () => {
  const onClose = vi.fn();
  const outer = vi.fn();
  render(
    // biome-ignore lint/a11y/noStaticElementInteractions: the test listens for keys that escape.
    <div onKeyDown={outer}>
      <ScopePopover
        scope={null}
        page={PAGE}
        onPick={vi.fn()}
        onClose={onClose}
      />
    </div>,
  );
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Scope" }), {
    key: "Escape",
  });
  expect(onClose).toHaveBeenCalled();
  expect(outer).not.toHaveBeenCalled();
});

test("the agent popover lists states, picks an agent and links to settings", async () => {
  mockBackend({
    agents_status: () => [
      {
        id: "claude",
        name: "Claude",
        state: { state: "ready" },
        detail: null,
        hint: null,
        isDefault: true,
        custom: false,
      },
      {
        id: "codex",
        name: "Codex",
        state: { state: "notInstalled" },
        detail: null,
        hint: null,
        isDefault: false,
        custom: false,
      },
    ],
  });
  const onPick = vi.fn();
  const onSettings = vi.fn();
  render(
    <AgentPopover
      current="claude"
      onPick={onPick}
      onSettings={onSettings}
      onClose={vi.fn()}
    />,
  );
  const codex = await screen.findByTestId("agent-pick-codex");
  expect(within(codex).getByText("Not installed")).toBeTruthy();
  expect(
    screen.getByTestId("agent-pick-claude").getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(codex);
  expect(onPick).toHaveBeenCalledWith("codex");
  fireEvent.click(screen.getByTestId("agent-pick-settings"));
  await waitFor(() => expect(onSettings).toHaveBeenCalled());
});
