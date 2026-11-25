import { act } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetAgentChatForTest, useAgentChat } from "../../stores/agentChat";
import { newCreateTab, resetDockForTest, useDock } from "../../stores/dock";
import { resetProposalsForTest, useProposals } from "../../stores/proposals";
import {
  registerTabSource,
  resetTabSourcesForTest,
  tabSource,
} from "../../stores/tabSources";
import { mockBackend } from "../../test/ipc";
import { proposal } from "../../test/proposals";
import { watchClosedTabs } from "./aiTabs";

beforeEach(() => {
  resetAgentChatForTest();
  resetProposalsForTest();
  resetTabSourcesForTest();
  resetDockForTest();
});

test("closing a YAML tab drops its proposal and detaches it from the running chat", async () => {
  const ipc = mockBackend({ chat_detach_tab: () => null });
  const tab = newCreateTab("c1");
  useDock.getState().open(tab);
  registerTabSource(tab.id, async () => {
    throw new Error("unused");
  });
  useProposals.getState().receive("chat-1", proposal({ tabId: tab.id }));
  useAgentChat.setState({
    start: { phase: "running", chatId: "chat-1" },
    tab: { tabId: tab.id, title: "Create" },
  });
  const stop = watchClosedTabs();
  act(() => useDock.getState().close(tab.id));
  await Promise.resolve();
  expect(useProposals.getState().byTab[tab.id]).toBeUndefined();
  expect(tabSource(tab.id)).toBeNull();
  expect(useAgentChat.getState().tab).toBeNull();
  expect(ipc.callsTo("chat_detach_tab")).toEqual([
    { chatId: "chat-1", tabId: tab.id },
  ]);
  stop();
});
