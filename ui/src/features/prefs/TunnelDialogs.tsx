import { useState } from "react";
import { Button, ConfirmDialog, Dialog, Input, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { TunnelView } from "../../ipc/generated/TunnelView";
import { useCatalog } from "../../stores/catalog";
import styles from "./PreferencesScreen.module.css";
import {
  checkTunnel,
  placeTunnelFailure,
  type TunnelFields,
  type TunnelProblems,
} from "./tunnelForm";

/** Adds a proxy tunnel, or edits `tunnel` (tunnels spec §5.1). */
export function TunnelDialog(props: {
  tunnel?: TunnelView;
  onClose(): void;
  onSaved?(view: TunnelView): void;
}) {
  const { tunnel } = props;
  const [fields, setFields] = useState<TunnelFields>({
    name: tunnel?.name ?? "",
    url: tunnel?.kind.url ?? "",
    username: tunnel?.kind.username ?? "",
    password: "",
  });
  // Set once saved, so a retry after a refused password edits instead of adding again.
  const [savedId, setSavedId] = useState<string | null>(tunnel?.id ?? null);
  const [hasPassword, setHasPassword] = useState(tunnel?.hasPassword ?? false);
  const [replacing, setReplacing] = useState(false);
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<TunnelProblems>({});
  const [saving, setSaving] = useState(false);
  const problems = tried ? { ...checkTunnel(fields), ...refusal } : refusal;

  const set =
    (field: keyof TunnelFields) => (e: { target: { value: string } }) => {
      setFields({ ...fields, [field]: e.target.value });
      setRefusal({});
    };

  async function clearPassword(): Promise<void> {
    if (savedId === null) return;
    try {
      await api.tunnelClearPassword(savedId);
      setHasPassword(false);
      setReplacing(false);
    } catch (error) {
      toast.error("Could not clear the password", failureMessage(error));
    }
  }

  async function save(): Promise<void> {
    setTried(true);
    if (Object.keys(checkTunnel(fields)).length > 0) return;
    setSaving(true);
    try {
      const username = fields.username.trim();
      let view = await api.tunnelSave({
        id: savedId,
        name: fields.name.trim(),
        kind: {
          type: "proxy",
          url: fields.url.trim(),
          username: username === "" ? null : username,
        },
      });
      setSavedId(view.id);
      if (fields.password !== "") {
        view = await api.tunnelSetPassword(view.id, fields.password);
      }
      props.onSaved?.(view);
      props.onClose();
    } catch (error) {
      setRefusal(placeTunnelFailure(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={tunnel ? `Edit tunnel ${tunnel.name}` : "Add a tunnel"}
      testId="tunnel-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() => {
              void save();
            }}
            data-testid="tunnel-save"
          >
            Save
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <Input
          label="Name"
          placeholder="corp"
          value={fields.name}
          error={problems.name}
          onChange={set("name")}
          data-testid="tunnel-name"
        />
        <Input
          label="Proxy URL"
          help="http://, https:// or socks5:// with a host and an optional port"
          placeholder="http://proxy.example:3128"
          className={styles.monoInput}
          value={fields.url}
          error={problems.url}
          onChange={set("url")}
          data-testid="tunnel-url"
        />
        <Input
          label="Username"
          value={fields.username}
          error={problems.username}
          onChange={set("username")}
          data-testid="tunnel-username"
        />
        {hasPassword && !replacing ? (
          <div
            className={styles.savedSecret}
            data-testid="tunnel-password-saved"
          >
            <span>Password</span>
            <span>{tunnel?.passwordNote ?? "Saved in the keychain"}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReplacing(true)}
              data-testid="tunnel-password-replace"
            >
              Replace
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void clearPassword();
              }}
              data-testid="tunnel-password-clear"
            >
              Clear
            </Button>
          </div>
        ) : (
          <Input
            label="Password"
            type="password"
            value={fields.password}
            error={problems.password}
            onChange={set("password")}
            data-testid="tunnel-password"
          />
        )}
        {problems.form ? (
          <p className={styles.formError} role="alert">
            {problems.form}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Deletes a tunnel; the clusters that use it go back to None (tunnels spec §5.1). */
export function TunnelDeleteDialog(props: {
  tunnel: TunnelView;
  onClose(): void;
}) {
  const { tunnel, onClose } = props;
  const clusters = useCatalog((s) => s.clusters);
  const users = clusters
    .filter((c) => c.tunnel === tunnel.id)
    .map((c) => c.name);
  let body = "No cluster uses it.";
  if (users.length === 1) body = `${users[0]} uses it and goes back to None.`;
  else if (users.length > 1)
    body = `${users.join(", ")} use it and go back to None.`;
  return (
    <ConfirmDialog
      open
      title={`Delete tunnel ${tunnel.name}?`}
      body={body}
      confirmLabel="Delete"
      danger
      testId="tunnel-delete-dialog"
      onConfirm={() => {
        api.tunnelDelete(tunnel.id).catch((error: unknown) => {
          toast.error(
            `Could not delete tunnel ${tunnel.name}`,
            failureMessage(error),
          );
        });
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
