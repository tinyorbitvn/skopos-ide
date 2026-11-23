import { type FormEvent, useEffect, useState } from "react";
import { IS_MAC } from "../../app/shortcuts";
import {
  Button,
  ErrorNotice,
  IconButton,
  Input,
  Spinner,
  StatusDot,
  toast,
} from "../../design";
import { X } from "../../design/icons";
import { failureMessage } from "../../ipc/client";
import { useAgents } from "../../stores/agents";
import { sandboxReason } from "../agents/agentText";
import styles from "./PreferencesScreen.module.css";
import { prefsSectionId } from "./paths";

function SandboxStatusRow() {
  const sandbox = useAgents((s) => s.sandbox);
  const error = useAgents((s) => s.sandboxError);
  const checking = useAgents((s) => s.sandboxChecking);
  const loadSandbox = useAgents((s) => s.loadSandbox);
  if (sandbox === null && error) {
    return (
      <ErrorNotice
        title="Could not read the sandbox status"
        message={error}
        onRetry={() => void loadSandbox(true)}
      />
    );
  }
  if (sandbox === null) return <Spinner />;
  if (sandbox.status === "ready") {
    return (
      <div className={styles.row} data-testid="pref-sandbox-status">
        <StatusDot tone="ok" label="Sandbox ready" />
        <span>Sandbox ready</span>
        <span className={styles.agentDetail}>
          {sandbox.kind === "bubblewrap" ? "bubblewrap" : "Seatbelt"}
        </span>
      </div>
    );
  }
  return (
    <div className={styles.row} data-testid="pref-sandbox-status">
      <StatusDot tone="danger" label="Sandbox not available" />
      <div className={styles.agentText}>
        <span>Sandbox not available</span>
        <span className={styles.muted}>{sandboxReason(sandbox, IS_MAC)}</span>
      </div>
      <span className={styles.toolAction}>
        <Button
          size="sm"
          loading={checking}
          onClick={() => void loadSandbox(true)}
          data-testid="pref-sandbox-check"
        >
          Check again
        </Button>
      </span>
    </div>
  );
}

/** A list the person edits: rows with Remove, then a field and Add. */
function EditableList(props: {
  testId: string;
  readOnlyRows?: string[];
  items: string[];
  placeholder: string;
  label: string;
  add(value: string): Promise<void>;
  remove(value: string): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await props.add(text.trim());
      setText("");
    } catch (error) {
      setProblem(failureMessage(error));
    }
  }

  return (
    <>
      <ul className={styles.rows} data-testid={props.testId}>
        {(props.readOnlyRows ?? []).map((row) => (
          <li key={`ro-${row}`} className={styles.row}>
            <span className={styles.path}>{row}</span>
          </li>
        ))}
        {props.items.map((item) => (
          <li key={item} className={styles.row}>
            <span className={styles.path}>{item}</span>
            <IconButton
              label={`Remove ${item}`}
              icon={<X size={14} aria-hidden="true" />}
              onClick={() =>
                void props
                  .remove(item)
                  .catch((error: unknown) =>
                    toast.error(
                      `Could not remove ${item}`,
                      failureMessage(error),
                    ),
                  )
              }
            />
          </li>
        ))}
      </ul>
      <form className={styles.add} onSubmit={(e) => void submit(e)}>
        <div className={styles.input}>
          <Input
            aria-label={props.label}
            placeholder={props.placeholder}
            value={text}
            error={problem}
            onChange={(e) => {
              setText(e.target.value);
              setProblem(undefined);
            }}
            data-testid={`${props.testId.replace(/s$/, "")}-input`}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={text.trim() === ""}
          data-testid={`${props.testId.replace(/s$/, "")}-add`}
        >
          Add
        </Button>
      </form>
    </>
  );
}

/** Preferences → Agent sandbox (spec §3.5): status, network allowlist and folders. */
export function AgentSandboxSection() {
  const statuses = useAgents((s) => s.statuses);
  const prefs = useAgents((s) => s.prefs);
  const prefsError = useAgents((s) => s.prefsError);
  const {
    loadSandbox,
    load,
    loadPrefs,
    addDomain,
    removeDomain,
    addFolder,
    removeFolder,
  } = useAgents.getState();

  useEffect(() => {
    void loadSandbox(false);
    void loadPrefs();
    if (useAgents.getState().statuses === null) void load();
  }, [loadSandbox, loadPrefs, load]);

  const hosts = (statuses ?? [])
    .filter((s) => s.state.state !== "notInstalled")
    .flatMap((s) => s.hosts.map((host) => `${host} · ${s.name}`));

  let lists = null;
  if (prefs === null && prefsError) {
    lists = (
      <ErrorNotice
        title="Could not read the agent settings"
        message={prefsError}
        onRetry={() => void loadPrefs()}
      />
    );
  } else if (prefs === null) {
    lists = <Spinner />;
  } else {
    lists = (
      <>
        <h4 className={styles.subheading}>Network</h4>
        <p className={styles.muted}>
          Each agent may reach its own model provider. Add other domains it
          needs.
        </p>
        <EditableList
          testId="pref-domains"
          readOnlyRows={hosts}
          items={prefs.domains}
          placeholder="example.com"
          label="Domain"
          add={addDomain}
          remove={removeDomain}
        />
        <h4 className={styles.subheading}>Folders</h4>
        <p className={styles.muted}>
          Agents can read these folders. They can write only to their own
          folder.
        </p>
        <EditableList
          testId="pref-folders"
          items={prefs.folders}
          placeholder="/path/to/folder"
          label="Folder"
          add={addFolder}
          remove={removeFolder}
        />
      </>
    );
  }

  return (
    <section
      id={prefsSectionId("agent-sandbox")}
      tabIndex={-1}
      className={`${styles.section} ${styles.anchor}`}
      data-testid="pref-agent-sandbox"
    >
      <h3 className={styles.heading}>Agent sandbox</h3>
      <p className={styles.muted}>
        Every agent runs in its own folder. It can read its own settings but not
        the rest of your home folder, your kubeconfig or your keys, and it
        reaches your clusters only through SkoposIDE's tools.
      </p>
      <SandboxStatusRow />
      {lists}
    </section>
  );
}
