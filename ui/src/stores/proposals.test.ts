import { beforeEach, expect, test } from "vitest";
import { mockBackend } from "../test/ipc";
import { proposal } from "../test/proposals";
import { resetProposalsForTest, useProposals } from "./proposals";

beforeEach(() => resetProposalsForTest());

test("a waiting card is the tab's pending proposal; its later state removes it", () => {
  useProposals.getState().receive("chat-1", proposal());
  expect(useProposals.getState().byTab["create-1"]?.card.id).toBe("p1");
  useProposals
    .getState()
    .receive("chat-1", proposal({ id: "p0", state: "replaced" }));
  expect(useProposals.getState().byTab["create-1"]?.card.id).toBe("p1");
  useProposals.getState().receive("chat-1", proposal({ state: "tabClosed" }));
  expect(useProposals.getState().byTab["create-1"]).toBeUndefined();
});

test("accept gives the text and tells the core; reject only tells", async () => {
  const ipc = mockBackend({ chat_proposal_answer: () => null });
  useProposals.getState().receive("chat-1", proposal());
  expect(useProposals.getState().accept("create-1")).toBe("kind: Service\n");
  expect(useProposals.getState().accept("create-1")).toBeNull();
  useProposals.getState().receive("chat-1", proposal({ id: "p2" }));
  useProposals.getState().reject("create-1");
  await Promise.resolve();
  expect(ipc.callsTo("chat_proposal_answer")).toEqual([
    { chatId: "chat-1", proposalId: "p1", accepted: true },
    { chatId: "chat-1", proposalId: "p2", accepted: false },
  ]);
});

test("reopen puts a card into another tab as waiting", () => {
  useProposals
    .getState()
    .reopen("create-9", "chat-1", proposal({ state: "tabClosed" }));
  expect(useProposals.getState().byTab["create-9"]?.card).toMatchObject({
    tabId: "create-9",
    state: "waiting",
  });
});
