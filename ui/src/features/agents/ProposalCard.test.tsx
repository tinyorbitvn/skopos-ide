import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { newCreateTab, resetDockForTest, useDock } from "../../stores/dock";
import { resetProposalsForTest, useProposals } from "../../stores/proposals";
import { proposal } from "../../test/proposals";
import { ProposalCard } from "./ProposalCard";

beforeEach(() => {
  resetDockForTest();
  resetProposalsForTest();
});

test("shows the tab, the summary, the counts and the state", () => {
  render(<ProposalCard card={proposal({ removed: 1 })} chatId="chat-1" live />);
  const card = screen.getByTestId("agent-proposal-card");
  expect(card.textContent).toContain("Create");
  expect(card.textContent).toContain("Add a Service");
  expect(card.textContent).toContain("+4 −1");
  expect(card.textContent).toContain("Waiting for you");
});

test("Show in tab selects the open tab and restores the dock", () => {
  const tab = newCreateTab("c1");
  useDock.getState().open(tab);
  useDock.getState().open(newCreateTab("c1"));
  useDock.getState().setMinimized(true);
  render(
    <ProposalCard card={proposal({ tabId: tab.id })} chatId="chat-1" live />,
  );
  fireEvent.click(screen.getByTestId("agent-proposal-show"));
  expect(useDock.getState()).toMatchObject({
    activeId: tab.id,
    minimized: false,
  });
});

test("Open in new tab puts the proposal into a fresh create tab", () => {
  render(
    <ProposalCard
      card={proposal({ state: "tabClosed" })}
      chatId="chat-1"
      live
    />,
  );
  expect(screen.getByTestId("agent-proposal-card").textContent).toContain(
    "Tab closed",
  );
  fireEvent.click(screen.getByTestId("agent-proposal-open"));
  const [tab] = useDock.getState().tabs;
  expect(tab).toMatchObject({
    kind: "create",
    clusterId: "c1",
    title: "Create",
  });
  expect(useProposals.getState().byTab[tab.id]?.card.state).toBe("waiting");
});

test("a saved card has no actions", () => {
  render(
    <ProposalCard
      card={proposal({ yaml: "", state: "accepted" })}
      chatId={null}
      live={false}
    />,
  );
  expect(screen.getByTestId("agent-proposal-card").textContent).toContain(
    "Accepted",
  );
  expect(screen.queryByTestId("agent-proposal-open")).toBeNull();
  expect(screen.queryByTestId("agent-proposal-show")).toBeNull();
});
