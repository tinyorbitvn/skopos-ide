import { useState } from "react";
import { clusterStatus } from "../../app/clusterStatus";
import { IS_MAC, shortKeys } from "../../app/shortcuts";
import { openPath } from "../../app/tabs/navigation";
import { Badge, IconButton, StatusDot } from "../../design";
import {
  ChevronDown,
  History,
  MessageSquarePlus,
  ShieldCheck,
  X,
} from "../../design/icons";
import { useAgentChat } from "../../stores/agentChat";
import { useAgents } from "../../stores/agents";
import { useCatalog } from "../../stores/catalog";
import { settingsPath } from "../settings/paths";
import styles from "./AgentPanel.module.css";
import { CHANGES_LABELS } from "./agentText";
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

/** The sandbox line (spec §3.2) and its details. */
export function SandboxLine() {
  const scope = useAgentChat((s) => s.scope);
  const settings = useAgentChat((s) => s.clusterSettings);
  const [open, setOpen] = useState(false);
  const clusterId = scope && !scope.global ? scope.clusters[0] : undefined;
  return (
    <div className={styles.sandbox} data-testid="agent-sandbox-line">
      <div className={styles.sandboxRow}>
        <span className={styles.shield}>
          <ShieldCheck size={14} aria-hidden="true" />
        </span>
        <span>Sandboxed</span>
        {clusterId && settings?.changes === "readOnly" ? (
          <span data-testid="agent-read-only">
            <Badge tone="neutral">Read only</Badge>
          </span>
        ) : null}
        <button
          type="button"
          className={styles.link}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid="agent-sandbox-details"
        >
          Details
        </button>
      </div>
      {open ? (
        <div className={styles.details}>
          <p>
            The agent runs in its own folder. It can read its own settings,
            where it keeps your sign-in, but not the rest of your home folder,
            your kubeconfig or your keys. It can reach only its model provider
            and SkoposIDE, and it reaches your clusters only through SkoposIDE's
            tools.
          </p>
          {clusterId ? (
            <>
              {settings ? (
                <ul
                  className={styles.settingsList}
                  aria-label="This cluster's agent settings"
                >
                  <li>{`Changes: ${CHANGES_LABELS[settings.changes]}`}</li>
                  <li>
                    {settings.namespaces
                      ? `Namespaces: ${settings.namespaces.join(", ")}`
                      : "Namespaces: all"}
                  </li>
                  <li>{`Secret values: ${settings.secretValues ? "readable" : "hidden"}`}</li>
                  <li>{`Commands in containers: ${settings.exec ? "on" : "off"}`}</li>
                </ul>
              ) : null}
              <button
                type="button"
                className={styles.link}
                onClick={() =>
                  openPath(settingsPath(clusterId, "agent"), "current")
                }
              >
                Cluster settings
              </button>
            </>
          ) : (
            <p>Each cluster's own agent settings apply.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
