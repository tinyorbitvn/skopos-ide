import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Segmented,
  toast,
} from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { TunnelView } from "../../ipc/generated/TunnelView";
import { useCatalog } from "../../stores/catalog";
import styles from "./PreferencesScreen.module.css";
import {
  checkSshTunnel,
  checkTunnel,
  placeTunnelFailure,
  type SshTunnelFields,
  sshKindOf,
  type TunnelFields,
  type TunnelProblems,
} from "./tunnelForm";

type SshText = Omit<SshTunnelFields, "name">;

/** The identity file, picked with the system dialog (tunnels spec §6.1). */
function IdentityField(props: {
  path: string;
  error?: string;
  onChange(path: string): void;
}) {
  async function choose(): Promise<void> {
    try {
      const picked = await open({ directory: false, multiple: false });
      if (typeof picked === "string") props.onChange(picked);
    } catch (error) {
      toast.error("Could not open the file picker", failureMessage(error));
    }
  }
  return (
    <div className={styles.identity}>
      <span className={styles.identityLabel}>Identity file</span>
      <div className={styles.identityRow}>
        <span
          className={styles.path}
          title={props.path}
          data-testid="tunnel-identity"
        >
          {props.path === "" ? "No file picked" : props.path}
        </span>
        <Button
          size="sm"
          onClick={() => void choose()}
          data-testid="tunnel-identity-choose"
        >
          Choose…
        </Button>
        {props.path !== "" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => props.onChange("")}
            data-testid="tunnel-identity-clear"
          >
            Clear
          </Button>
        ) : null}
      </div>
      {props.error ? (
        <p className={styles.formError} role="alert">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** Adds a proxy or SSH tunnel, or edits `tunnel` (tunnels spec §5.1, §6.1). */
export function TunnelDialog(props: {
  tunnel?: TunnelView;
  onClose(): void;
  onSaved?(view: TunnelView): void;
}) {
  const { tunnel } = props;
  const kind = tunnel?.kind;
  const proxy = kind?.type === "proxy" ? kind : null;
  const [fields, setFields] = useState<TunnelFields>({
    name: tunnel?.name ?? "",
    url: proxy?.url ?? "",
    username: proxy?.username ?? "",
    password: "",
  });
  const ssh = kind?.type === "ssh" ? kind : null;
  // The kind is chosen when adding; an existing tunnel keeps its kind.
  const [type, setType] = useState<"proxy" | "ssh">(kind?.type ?? "proxy");
  const [sshText, setSshText] = useState<SshText>({
    host: ssh?.host ?? "",
    user: ssh?.user ?? "",
    port: ssh?.port?.toString() ?? "",
    jump: ssh?.jump ?? "",
    identityFile: ssh?.identityFile ?? "",
  });
  const sshFields = (): SshTunnelFields => ({ name: fields.name, ...sshText });
  const check = (): TunnelProblems =>
    type === "proxy" ? checkTunnel(fields) : checkSshTunnel(sshFields());
  // Set once saved, so a retry after a refused password edits instead of adding again.
  const [savedId, setSavedId] = useState<string | null>(tunnel?.id ?? null);
  const [hasPassword, setHasPassword] = useState(tunnel?.hasPassword ?? false);
  const [replacing, setReplacing] = useState(false);
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<TunnelProblems>({});
  const [saving, setSaving] = useState(false);
  const problems = tried ? { ...check(), ...refusal } : refusal;

  const set =
    (field: keyof TunnelFields) => (e: { target: { value: string } }) => {
      setFields({ ...fields, [field]: e.target.value });
      setRefusal({});
    };

  const setSsh =
    (field: keyof SshText) => (e: { target: { value: string } }) => {
      setSshText({ ...sshText, [field]: e.target.value });
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
    if (Object.keys(check()).length > 0) return;
    setSaving(true);
    try {
      const username = fields.username.trim();
      let view = await api.tunnelSave({
        id: savedId,
        name: fields.name.trim(),
        kind:
          type === "proxy"
            ? {
                type: "proxy",
                url: fields.url.trim(),
                username: username === "" ? null : username,
              }
            : sshKindOf(sshFields()),
      });
      setSavedId(view.id);
      if (type === "proxy" && fields.password !== "") {
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
        {tunnel === undefined ? (
          <Segmented
            label="Kind"
            value={type}
            options={[
              { value: "proxy", label: "Proxy" },
              { value: "ssh", label: "SSH" },
            ]}
            onChange={(next) => {
              setType(next);
              setRefusal({});
            }}
            testId="tunnel-kind"
          />
        ) : null}
        <Input
          label="Name"
          placeholder="corp"
          value={fields.name}
          error={problems.name}
          onChange={set("name")}
          data-testid="tunnel-name"
        />
        {type === "proxy" ? (
          <>
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
          </>
        ) : (
          <>
            <Input
              label="Host"
              help="A host name or an alias from ~/.ssh/config, such as coder.my-workspace"
              placeholder="bastion.example.com"
              className={styles.monoInput}
              value={sshText.host}
              error={problems.host}
              onChange={setSsh("host")}
              data-testid="tunnel-host"
            />
            <Input
              label="User"
              value={sshText.user}
              error={problems.user}
              onChange={setSsh("user")}
              data-testid="tunnel-user"
            />
            <Input
              label="Port"
              inputMode="numeric"
              placeholder="22"
              value={sshText.port}
              error={problems.port}
              onChange={setSsh("port")}
              data-testid="tunnel-port"
            />
            <Input
              label="Jump host"
              help="Passed to ssh -J"
              className={styles.monoInput}
              value={sshText.jump}
              error={problems.jump}
              onChange={setSsh("jump")}
              data-testid="tunnel-jump"
            />
            <IdentityField
              path={sshText.identityFile}
              error={problems.identityFile}
              onChange={(identityFile) => {
                setSshText({ ...sshText, identityFile });
                setRefusal({});
              }}
            />
            <p className={styles.muted} data-testid="tunnel-ssh-note">
              While it runs, other programs on this computer can reach the same
              network through its local port
            </p>
          </>
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

/**
 * Confirms `Stop` while connected clusters use the tunnel: they disconnect, and nothing
 * starts it again by itself (tunnels spec §5.1; the 2026-11-27 ruling).
 */
export function TunnelStopDialog(props: {
  tunnel: TunnelView;
  clusters: string[];
  onConfirm(): void;
  onClose(): void;
}) {
  const { tunnel, clusters } = props;
  const body =
    clusters.length === 1
      ? `${clusters[0]} disconnects.`
      : `${clusters.join(", ")} disconnect.`;
  return (
    <ConfirmDialog
      open
      title={`Stop tunnel ${tunnel.name}?`}
      body={body}
      confirmLabel="Stop"
      danger
      testId="tunnel-stop-dialog"
      onConfirm={() => {
        props.onConfirm();
        props.onClose();
      }}
      onCancel={props.onClose}
    />
  );
}
