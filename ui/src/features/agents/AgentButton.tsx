import { useCurrentCluster } from "../../app/currentCluster";
import { IS_MAC, shortKeys } from "../../app/shortcuts";
import { IconButton } from "../../design";
import { Sparkles } from "../../design/icons";
import { useAgentChat } from "../../stores/agentChat";
import styles from "./AgentButton.module.css";
import { waitingCount } from "./chatModel";

/** The header's agent button (spec §3.1): toggles the panel, with a dot while a change waits. */
export function AgentButton() {
  const open = useAgentChat((s) => s.open);
  const waiting = useAgentChat((s) => waitingCount(s.items) > 0);
  const page = useCurrentCluster();
  const keys = shortKeys("agent", IS_MAC);
  const dot = waiting && !open;
  return (
    <span className={styles.wrap}>
      <IconButton
        label={
          dot
            ? `Agent (${keys}), a change is waiting for you`
            : `Agent (${keys})`
        }
        icon={<Sparkles size={16} aria-hidden="true" />}
        aria-pressed={open}
        aria-keyshortcuts={IS_MAC ? "Meta+J" : "Control+J"}
        onClick={() => useAgentChat.getState().toggle(page?.id ?? null)}
        data-testid="agent-toggle"
      />
      {dot ? (
        <span
          className={styles.dot}
          aria-hidden="true"
          data-testid="agent-waiting-dot"
        />
      ) : null}
    </span>
  );
}
