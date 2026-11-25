import { api } from "../../ipc/api";
import { runningChatId, useAgentChat } from "../../stores/agentChat";
import { useDock } from "../../stores/dock";
import { useProposals } from "../../stores/proposals";
import { dropTabSource } from "../../stores/tabSources";

const ignore = () => {};

/** When a YAML tab closes, its proposal goes and the running chat lets go of it (spec A6). */
export function watchClosedTabs(): () => void {
  let open = new Set(useDock.getState().tabs.map((tab) => tab.id));
  return useDock.subscribe((state) => {
    const now = new Set(state.tabs.map((tab) => tab.id));
    for (const id of open) {
      if (now.has(id) || !dropTabSource(id)) continue;
      useProposals.getState().drop(id);
      const chat = useAgentChat.getState();
      if (chat.tab?.tabId === id) useAgentChat.setState({ tab: null });
      const chatId = runningChatId(chat);
      if (chatId) void api.chatDetachTab(chatId, id).catch(ignore);
    }
    open = now;
  });
}
