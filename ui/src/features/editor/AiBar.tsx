import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../../design";
import { Send, X } from "../../design/icons";
import { useAgentChat } from "../../stores/agentChat";
import styles from "./AiBar.module.css";

/** The tab's AI bar (YAML authoring spec A1, A2): a request to the agent about this tab. */
export function AiBar(props: {
  tabId: string;
  placeholder: string;
  disabled: boolean;
  onClose(): void;
}) {
  const [text, setText] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // The bar opens focused, from Ask AI or from Draft with AI (spec D3).
  useEffect(() => {
    input.current?.focus();
  }, []);

  async function send(): Promise<void> {
    const sending = text.trim();
    if (sending === "" || working || props.disabled) return;
    setText("");
    setError(null);
    setWorking(true);
    const result = await useAgentChat
      .getState()
      .askFromTab(props.tabId, sending);
    setWorking(false);
    if (result === "sent") return;
    setText(sending);
    if (typeof result === "object") setError(result.failed);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  }

  const rows = Math.min(4, Math.max(1, text.split("\n").length));
  return (
    <div className={styles.bar} data-testid="yaml-ai-bar">
      <textarea
        ref={input}
        className={styles.input}
        rows={rows}
        value={text}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
        data-testid="yaml-ai-input"
      />
      {working ? (
        <>
          <span className={styles.status} role="status">
            Working
          </span>
          <Button
            size="sm"
            onClick={() => void useAgentChat.getState().stop()}
            data-testid="yaml-ai-stop"
          >
            Stop
          </Button>
        </>
      ) : (
        <IconButton
          label="Send"
          icon={<Send size={14} aria-hidden="true" />}
          disabled={props.disabled || text.trim() === ""}
          onClick={() => void send()}
          data-testid="yaml-ai-send"
        />
      )}
      <IconButton
        label="Close"
        icon={<X size={14} aria-hidden="true" />}
        onClick={props.onClose}
        data-testid="yaml-ai-close"
      />
      {error ? (
        <p className={styles.error} role="alert" data-testid="yaml-ai-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
