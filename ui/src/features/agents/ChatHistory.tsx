import { EmptyState, ErrorNotice, Spinner } from "../../design";
import { useAgentChat } from "../../stores/agentChat";
import styles from "./AgentPanel.module.css";
import { countText, whenText } from "./agentText";

/** The scope's chats, newest first (spec §3.4). */
export function ChatHistory() {
  const history = useAgentChat((s) => s.history);
  const global = useAgentChat((s) => s.scope?.global ?? false);
  const chat = useAgentChat.getState();
  if (history.error !== null) {
    return (
      <div className={styles.center}>
        <ErrorNotice
          title="Could not read the chats"
          message={history.error}
          onRetry={() => void chat.loadHistory()}
        />
      </div>
    );
  }
  if (history.rows === null) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }
  if (history.rows.length === 0) {
    return (
      <div className={styles.center}>
        <EmptyState title="No chats yet" />
      </div>
    );
  }
  const now = new Date();
  return (
    <ul
      className={styles.history}
      aria-label="Chat history"
      data-testid="agent-history-list"
    >
      {history.rows.map((row) => {
        const meta = [row.agent, whenText(row.updated, now)];
        if (global) meta.push(countText(row.clusters, "cluster", "clusters"));
        return (
          <li key={row.id}>
            <button
              type="button"
              className={styles.historyRow}
              onClick={() => void chat.openStored(row.id)}
              data-testid={`agent-history-${row.id}`}
            >
              <span className={styles.historyTitle}>{row.title}</span>
              <span className={styles.historyMeta}>{meta.join(" · ")}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
