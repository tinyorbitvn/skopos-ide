import { type ReactNode, useEffect, useRef, useState } from "react";
import { useCurrentCluster } from "../../app/currentCluster";
import { openPath } from "../../app/tabs/navigation";
import { useAgentChat } from "../../stores/agentChat";
import { useAgents } from "../../stores/agents";
import { prefsPath } from "../prefs/paths";
import styles from "./AgentPanel.module.css";
import { AgentPopover } from "./AgentPopover";
import { ChatHistory } from "./ChatHistory";
import { ChatStream } from "./ChatStream";
import { Composer } from "./Composer";
import { PanelHeader, type PopoverName, SandboxLine } from "./PanelHeader";
import {
  ConnectBanner,
  FailureState,
  NewChatView,
  ReopenBar,
  StartingState,
} from "./PanelStates";
import { ScopePopover } from "./ScopePopover";
import { agentsSupported } from "./supported";

function OpenPanel() {
  const page = useCurrentCluster();
  const pageId = page?.id ?? null;
  const view = useAgentChat((s) => s.view);
  const start = useAgentChat((s) => s.start);
  const items = useAgentChat((s) => s.items);
  const busy = useAgentChat((s) => s.busy);
  const agentName = useAgentChat((s) => s.agentName);
  const agentId = useAgentChat((s) => s.agentId);
  const picked = useAgentChat((s) => s.picked);
  const cannotReopen = useAgentChat((s) => s.cannotReopen);
  const past = useAgentChat((s) => s.past);
  const undone = useAgentChat((s) => s.undone);
  const scope = useAgentChat((s) => s.scope);
  const defaultAgent = useAgents(
    (s) => s.statuses?.find((r) => r.isDefault)?.id ?? null,
  );
  const chat = useAgentChat.getState();
  const [popover, setPopover] = useState<PopoverName>(null);
  const root = useRef<HTMLElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);
  const scopeButton = useRef<HTMLButtonElement>(null);
  const agentButton = useRef<HTMLButtonElement>(null);

  // Opening the panel puts the cursor in the message box (board).
  useEffect(() => {
    (message.current ?? root.current)?.focus();
  }, []);

  function closePopover(): void {
    const from = popover;
    setPopover(null);
    (from === "agent" ? agentButton : scopeButton).current?.focus();
  }

  let body: ReactNode;
  if (view === "history") {
    body = <ChatHistory />;
  } else if (start.phase === "failed") {
    body = <FailureState failure={start.failure} />;
  } else if (
    (start.phase === "idle" || start.phase === "starting") &&
    items.length === 0
  ) {
    body = <StartingState />;
  } else if (start.phase === "running" && items.length === 0) {
    body = <NewChatView />;
  } else {
    body = (
      <ChatStream
        items={items}
        busy={busy}
        agentName={agentName ?? "The agent"}
        live={start.phase === "running"}
        past={past}
        undone={undone}
        onAnswer={(cardId, answer) => chat.answer(cardId, answer)}
        onUndo={(card) => void chat.undo(card)}
        onNewChat={() => void chat.newChat(pageId)}
      />
    );
  }

  const inChat = view === "chat";
  const clusterId = scope && !scope.global ? scope.clusters[0] : undefined;
  return (
    <aside
      ref={root}
      tabIndex={-1}
      aria-label="Agent"
      className={styles.panel}
      data-agent-panel=""
      data-testid="agent-panel"
    >
      <PanelHeader
        page={pageId}
        popover={popover}
        setPopover={setPopover}
        scopeRef={scopeButton}
        agentRef={agentButton}
      />
      <SandboxLine />
      <div className={styles.body}>{body}</div>
      {inChat && cannotReopen !== null ? (
        <ReopenBar
          agent={cannotReopen}
          onNewChat={() => void chat.newChat(pageId)}
        />
      ) : null}
      {inChat && cannotReopen === null && start.phase !== "failed" ? (
        <>
          {clusterId ? <ConnectBanner clusterId={clusterId} /> : null}
          <Composer textRef={message} ended={start.phase === "ended"} />
        </>
      ) : null}
      {popover === "scope" ? (
        <ScopePopover
          scope={scope}
          page={page}
          onPick={(next) => void chat.setScope(next)}
          onClose={closePopover}
        />
      ) : null}
      {popover === "agent" ? (
        <AgentPopover
          current={agentId ?? picked ?? defaultAgent}
          onPick={(id) => void chat.pickAgent(id)}
          onSettings={() => openPath(prefsPath("agents"), "current")}
          onClose={closePopover}
        />
      ) : null}
    </aside>
  );
}

/**
 * The agent panel (spec §3.2): a column on the right of the shell's body. It starts closed
 * in each window and keeps its chat while closed. No agent UI exists on Windows.
 */
export function AgentPanel() {
  const open = useAgentChat((s) => s.open);
  if (!agentsSupported() || !open) return null;
  return <OpenPanel />;
}
