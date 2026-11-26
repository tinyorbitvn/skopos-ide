import { useEffect } from "react";
import { openPath } from "../../app/tabs/navigation";
import {
  IconButton,
  RadioGroup,
  Segmented,
  Select,
  Switch,
} from "../../design";
import { TriangleAlert, X } from "../../design/icons";
import type { AgentChanges } from "../../ipc/generated/AgentChanges";
import { useAgents } from "../../stores/agents";
import { CHANGES_OPTIONS } from "../agents/agentText";
import { prefsPath } from "../prefs/paths";
import styles from "./ClusterSettingsScreen.module.css";
import { AGENT_CARD_ID } from "./paths";
import {
  agentNamespaceList,
  type DraftErrors,
  type SettingsDraft,
} from "./settingsForm";

const HELP: Record<AgentChanges, string> = {
  ask: "The agent asks you before each change.",
  readOnly: "The agent gets no tools that change anything.",
  dontAsk:
    "Changes run without asking. Use this only for a cluster you can rebuild.",
};
const APP_DEFAULT = "app-default";
const ADD = "add";

/** The Agent card of a cluster's Settings page (agents spec §3.6), part of the page's draft. */
export function AgentCard(props: {
  clusterName: string;
  draft: SettingsDraft;
  errors: DraftErrors;
  update(fields: Partial<SettingsDraft>): void;
  /** The connected cluster's namespaces, else its Accessible namespaces setting. */
  namespaces: string[];
}) {
  const { clusterName, draft, errors, update } = props;
  const statuses = useAgents((s) => s.statuses);
  useEffect(() => {
    if (useAgents.getState().statuses === null)
      void useAgents.getState().load();
  }, []);

  const picked = agentNamespaceList(draft);
  const others = props.namespaces.filter((n) => !picked.includes(n));
  const appDefault = statuses?.find((s) => s.isDefault)?.name;
  const agents = (statuses ?? []).filter(
    (s) => s.state.state === "ready" || s.id === draft.agentDefault,
  );
  const warn = draft.agentChanges === "dontAsk";

  return (
    <section
      id={AGENT_CARD_ID}
      tabIndex={-1}
      className={`${styles.section} ${styles.anchor}`}
      data-testid="settings-agent-card"
    >
      <h2 className={styles.heading}>Agent</h2>
      <p className={styles.sub}>
        {`How agents work with ${clusterName}. Settings for every cluster are in `}
        <button
          type="button"
          className={styles.link}
          onClick={() => openPath(prefsPath("agents"), "current")}
        >
          Preferences
        </button>
        .
      </p>

      <div className={styles.field}>
        <Segmented
          label="Changes"
          size="sm"
          value={draft.agentChanges}
          options={CHANGES_OPTIONS}
          onChange={(agentChanges) => update({ agentChanges })}
          testId="settings-agent-changes"
        />
        <p className={warn ? styles.warning : styles.help}>
          {warn ? <TriangleAlert size={14} aria-hidden="true" /> : null}
          {HELP[draft.agentChanges]}
        </p>
      </div>

      <div className={styles.field}>
        <RadioGroup
          legend="Namespaces the agent can see"
          value={draft.agentNamespacesOnly ? "only" : "all"}
          options={[
            { value: "all", label: "All namespaces" },
            { value: "only", label: "Only these namespaces" },
          ]}
          onChange={(v) => update({ agentNamespacesOnly: v === "only" })}
          testId="settings-agent-namespaces-mode"
        />
        {draft.agentNamespacesOnly ? (
          <div className={styles.chips}>
            {picked.map((ns) => (
              <span key={ns} className={styles.chip}>
                {ns}
                <IconButton
                  label={`Remove ${ns}`}
                  icon={<X size={12} aria-hidden="true" />}
                  onClick={() =>
                    update({
                      agentNamespaces: picked.filter((n) => n !== ns).join(","),
                    })
                  }
                />
              </span>
            ))}
            <Select
              label={
                props.namespaces.length === 0
                  ? "Connect to list namespaces"
                  : "Add a namespace"
              }
              hideLabel
              value={ADD}
              disabled={others.length === 0}
              options={[
                {
                  value: ADD,
                  label:
                    props.namespaces.length === 0
                      ? "Connect to list namespaces"
                      : "Add a namespace",
                },
                ...others.map((n) => ({ value: n, label: n })),
              ]}
              onChange={(ns) => {
                if (ns !== ADD)
                  update({ agentNamespaces: [...picked, ns].join(",") });
              }}
              testId="settings-agent-namespace-add"
            />
          </div>
        ) : null}
        <p className={styles.help}>
          The agent's tools return nothing from other namespaces, and it cannot
          change them.
        </p>
        {errors.agentNamespaces ? (
          <p className={styles.fieldError} role="alert">
            {errors.agentNamespaces}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <Switch
          label="Let the agent read Secret values"
          checked={draft.agentSecretValues}
          onChange={(agentSecretValues) => update({ agentSecretValues })}
          description="When off, the agent sees Secret names and keys, never their values."
          testId="settings-agent-secrets"
        />
        {warn && !draft.agentSecretValues ? (
          <p className={styles.warning}>
            <TriangleAlert size={14} aria-hidden="true" />
            Under Don't ask, an agent that changes workloads can still find ways
            to read the Secrets they use. Pick Ask every time or limit the
            namespaces where that matters.
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <Switch
          label="Let the agent run commands in containers"
          checked={draft.agentExec}
          onChange={(agentExec) => update({ agentExec })}
          description="Each command counts as a change and follows Changes above."
          testId="settings-agent-exec"
        />
      </div>

      <div className={styles.field}>
        <Switch
          label="Let the agent run commands in a terminal"
          checked={draft.agentTerminal}
          disabled={draft.agentChanges === "readOnly"}
          onChange={(agentTerminal) => update({ agentTerminal })}
          description={
            draft.agentChanges === "readOnly"
              ? "Read only gives the agent no terminal."
              : "The agent can run any shell command on this computer, in an Agent tab of the dock with this cluster's kubeconfig. Each command counts as a change and follows Changes above."
          }
          testId="settings-agent-terminal"
        />
      </div>

      <div className={styles.field}>
        <Select
          label="Default agent"
          value={draft.agentDefault ?? APP_DEFAULT}
          options={[
            {
              value: APP_DEFAULT,
              label: appDefault ? `App default (${appDefault})` : "App default",
            },
            ...agents.map((a) => ({ value: a.id, label: a.name })),
          ]}
          onChange={(v) =>
            update({ agentDefault: v === APP_DEFAULT ? null : v })
          }
          testId="settings-agent-default"
        />
        <p
          className={styles.help}
        >{`New chats on ${clusterName} start with this agent.`}</p>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="settings-agent-notes">
          Notes for the agent
        </label>
        <textarea
          id="settings-agent-notes"
          className={styles.textarea}
          rows={4}
          maxLength={4000}
          placeholder="For example: Deploys go through Argo CD, so suggest changes to the Git repository instead of editing objects."
          value={draft.agentNotes}
          onChange={(e) => update({ agentNotes: e.target.value })}
          data-testid="settings-agent-notes"
        />
        <p className={styles.help}>
          {`Sent to the agent at the start of every chat on ${clusterName}.`}
        </p>
      </div>
    </section>
  );
}
