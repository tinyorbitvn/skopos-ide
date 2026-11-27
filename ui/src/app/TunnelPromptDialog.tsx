import { useState } from "react";
import { Button, Dialog, Input, Switch, toast } from "../design";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { TunnelPrompt } from "../ipc/generated/TunnelPrompt";
import styles from "./TunnelPromptDialog.module.css";

const FIELD_LABELS: Partial<Record<TunnelPrompt["kind"], string>> = {
  passphrase: "Passphrase",
  password: "Password",
  other: "Answer",
};

/**
 * One question from `ssh` (tunnels spec §6.1, §6.3), its text shown as `ssh` wrote it. The
 * answer crosses IPC inward only; closing the dialog is a cancel.
 */
export function TunnelPromptDialog(props: {
  name: string;
  prompt: TunnelPrompt;
  onDone(): void;
}) {
  const { prompt } = props;
  const [answer, setAnswer] = useState("");
  const [remember, setRemember] = useState(false);
  const [sending, setSending] = useState(false);
  const field = FIELD_LABELS[prompt.kind];
  const secret = prompt.kind === "passphrase" || prompt.kind === "password";

  async function send(): Promise<void> {
    setSending(true);
    try {
      await api.tunnelPromptAnswer(
        prompt.id,
        field === undefined ? "" : answer,
        prompt.canRemember && remember,
      );
    } catch (error) {
      toast.error("Could not send the answer", failureMessage(error));
    } finally {
      setSending(false);
      props.onDone();
    }
  }

  async function cancel(): Promise<void> {
    try {
      await api.tunnelPromptCancel(prompt.id);
    } catch (error) {
      toast.error("Could not send the answer", failureMessage(error));
    } finally {
      props.onDone();
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void cancel();
      }}
      title={`SSH for "${props.name}"`}
      testId="tunnel-prompt"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => void cancel()}
            data-testid="tunnel-prompt-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={sending}
            onClick={() => void send()}
            data-testid="tunnel-prompt-continue"
          >
            {prompt.kind === "hostKey" ? "Trust and connect" : "Continue"}
          </Button>
        </>
      }
    >
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <p className={styles.text} data-testid="tunnel-prompt-text">
          {prompt.text}
        </p>
        {field !== undefined ? (
          <Input
            label={field}
            type={secret ? "password" : "text"}
            autoComplete="off"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            data-testid="tunnel-prompt-answer"
          />
        ) : null}
        {prompt.canRemember ? (
          <Switch
            label="Remember in the keychain"
            checked={remember}
            onChange={setRemember}
            testId="tunnel-prompt-remember"
          />
        ) : null}
      </form>
    </Dialog>
  );
}
