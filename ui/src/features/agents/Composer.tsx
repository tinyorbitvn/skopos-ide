import type { KeyboardEvent, Ref } from "react";
import { Button, IconButton } from "../../design";
import { CircleStop, Send, X } from "../../design/icons";
import { runningChatId, useAgentChat } from "../../stores/agentChat";
import { useCatalog } from "../../stores/catalog";
import styles from "./AgentPanel.module.css";
import { objectLabel, scopeChip, scopeLabel } from "./chatModel";

/** Enter sends; Shift+Enter adds a line; an IME's Enter confirms its text (spec §3.2). */
function sends(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229
  );
}

/** The composer (spec §3.2): chips, the message box, Send or Stop. */
export function Composer(props: {
  textRef: Ref<HTMLTextAreaElement>;
  ended: boolean;
}) {
  const draft = useAgentChat((s) => s.draft);
  const object = useAgentChat((s) => s.object);
  const scope = useAgentChat((s) => s.scope);
  const settings = useAgentChat((s) => s.clusterSettings);
  const busy = useAgentChat((s) => s.busy);
  const running = useAgentChat((s) => runningChatId(s) !== null);
  const clusters = useCatalog((s) => s.clusters);
  const chat = useAgentChat.getState();
  const placeholder =
    scope && !scope.global
      ? `Ask about ${scopeLabel(scope, clusters)}…`
      : "Ask about your clusters…";

  return (
    <div className={styles.composer}>
      <div className={styles.chips}>
        {scope ? (
          <span className={styles.chip} data-testid="agent-scope-chip">
            {scopeChip(scope, clusters, settings)}
          </span>
        ) : null}
        {object ? (
          <span className={styles.chip} data-testid="agent-object-chip">
            {objectLabel(object)}
            <IconButton
              label="Remove"
              icon={<X size={12} aria-hidden="true" />}
              onClick={() => chat.removeObject()}
              data-testid="agent-object-remove"
            />
          </span>
        ) : null}
      </div>
      <textarea
        ref={props.textRef}
        className={styles.textarea}
        aria-label="Message"
        rows={3}
        placeholder={placeholder}
        value={draft}
        disabled={props.ended}
        onChange={(e) => chat.setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (!sends(e)) return;
          e.preventDefault();
          void chat.send();
        }}
        data-testid="agent-message"
      />
      <div className={styles.composerActions}>
        {busy ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void chat.stop()}
            data-testid="agent-stop"
          >
            <CircleStop size={14} aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <IconButton
            label="Send (Enter)"
            icon={<Send size={14} aria-hidden="true" />}
            disabled={!running || draft.trim() === ""}
            onClick={() => void chat.send()}
            data-testid="agent-send"
          />
        )}
      </div>
    </div>
  );
}
