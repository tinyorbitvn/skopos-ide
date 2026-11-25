import { clusterStatus } from "../../app/clusterStatus";
import { IS_MAC, shortKeys } from "../../app/shortcuts";
import { Badge, IconButton, StatusDot } from "../../design";
import { ChevronDown, History, MessageSquarePlus, X } from "../../design/icons";
import { useAgentChat } from "../../stores/agentChat";
import { useAgents } from "../../stores/agents";
import { useCatalog } from "../../stores/catalog";
import styles from "./AgentPanel.module.css";
import { scopeLabel } from "./chatModel";

export type PopoverName = "scope" | "agent" | null;

/** The panel's header row (spec §3.2): scope, agent, New chat, Chat history, Close. */
export function PanelHeader(props: {
  page: string | null;
  popover: PopoverName;
  setPopover(name: PopoverName): void;
  scopeRef: React.Ref<HTMLButtonElement>;
  agentRef: React.Ref<HTMLButtonElement>;
}) {
  const scope = useAgentChat((s) => s.scope);
  const agentName = useAgentChat((s) => s.agentName);
  const picked = useAgentChat((s) => s.picked);
  const view = useAgentChat((s) => s.view);
  const statuses = useAgents((s) => s.statuses);
  const clusters = useCatalog((s) => s.clusters);
  const own =
    scope && !scope.global
      ? clusters.find((c) => c.id === scope.clusters[0])
      : undefined;
  const status = own ? clusterStatus(own.state) : null;
  const shownAgent =
    agentName ??
    statuses?.find((s) => s.id === picked)?.name ??
    statuses?.find((s) => s.isDefault)?.name ??
    "Agent";
  const settings = useAgentChat((s) => s.clusterSettings);
  const clusterId = scope && !scope.global ? scope.clusters[0] : undefined;
  const chat = useAgentChat.getState();
  const toggle = (name: Exclude<PopoverName, null>) =>
    props.setPopover(props.popover === name ? null : name);

  return (
    <div className={styles.header}>
      {scope ? (
        <button
          ref={props.scopeRef}
          type="button"
          className={styles.scopeButton}
          aria-haspopup="dialog"
          aria-expanded={props.popover === "scope"}
          onClick={() => toggle("scope")}
          data-testid="agent-scope"
        >
          {status ? (
            <StatusDot tone={status.tone} label={status.label} />
          ) : null}
          <span className={styles.ellipsis}>{scopeLabel(scope, clusters)}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ) : null}
      <button
        ref={props.agentRef}
        type="button"
        className={styles.agentButton}
        aria-haspopup="dialog"
        aria-expanded={props.popover === "agent"}
        onClick={() => toggle("agent")}
        data-testid="agent-pick"
      >
        <span className={styles.ellipsis}>{shownAgent}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {clusterId && settings?.changes === "readOnly" ? (
        <span data-testid="agent-read-only">
          <Badge tone="neutral">Read only</Badge>
        </span>
      ) : null}
      <div className={styles.grow} />
      <IconButton
        label="New chat"
        icon={<MessageSquarePlus size={16} aria-hidden="true" />}
        onClick={() => void chat.newChat(props.page)}
        data-testid="agent-new-chat"
      />
      <IconButton
        label="Chat history"
        icon={<History size={16} aria-hidden="true" />}
        aria-pressed={view === "history"}
        onClick={() => chat.showHistory(view !== "history")}
        data-testid="agent-history"
      />
      <IconButton
        label={`Close (${shortKeys("agent", IS_MAC)})`}
        icon={<X size={16} aria-hidden="true" />}
        onClick={() => chat.closePanel()}
        data-testid="agent-close"
      />
    </div>
  );
}
