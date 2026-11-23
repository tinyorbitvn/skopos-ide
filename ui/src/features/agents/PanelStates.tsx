import { openPath } from "../../app/tabs/navigation";
import { Button, EmptyState, Spinner } from "../../design";
import { Sparkles } from "../../design/icons";
import { useAgentChat } from "../../stores/agentChat";
import { useCatalog } from "../../stores/catalog";
import { useConnect } from "../../stores/clusters";
import { type PrefsSection, prefsPath } from "../prefs/paths";
import { settingsPath } from "../settings/paths";
import styles from "./AgentPanel.module.css";
import { type StartFailure, scopeLabel } from "./chatModel";

const CLUSTER_SUGGESTIONS = [
  "Why is a Pod restarting?",
  "What changed in the last hour?",
  "Which Deployments are not ready?",
];
const GLOBAL_SUGGESTIONS = [
  "Which clusters run an old ingress-nginx?",
  "Where are Pods failing right now?",
  "Compare node capacity across clusters",
];

function openPrefs(section: PrefsSection): void {
  openPath(prefsPath(section), "current");
}

export function StartingState() {
  return (
    <div className={styles.center}>
      <Spinner label="Starting the agent…" />
    </div>
  );
}

function State(props: {
  kind: StartFailure["kind"];
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={styles.center}
      data-testid="agent-state"
      data-kind={props.kind}
    >
      <EmptyState title={props.title} body={props.body} action={props.action} />
    </div>
  );
}

/** Why there is no chat (spec §3.3, P5, P17). */
export function FailureState(props: { failure: StartFailure }) {
  const { failure } = props;
  const retry = (label: string) => (
    <Button
      onClick={() => void useAgentChat.getState().retry()}
      data-testid="agent-retry"
    >
      {label}
    </Button>
  );
  switch (failure.kind) {
    case "noClusters":
      return (
        <State
          kind={failure.kind}
          title="No clusters yet"
          body="Add a cluster to the catalog to chat about it."
        />
      );
    case "noAgent":
      return (
        <State
          kind={failure.kind}
          title="No agent is ready"
          body="Install an agent CLI, or add one in Agent settings, then check again."
          action={
            <div className={styles.stateActions}>
              {retry("Check again")}
              <Button variant="ghost" onClick={() => openPrefs("agents")}>
                Agent settings
              </Button>
            </div>
          }
        />
      );
    case "sandbox":
      return (
        <State
          kind={failure.kind}
          title="The agent sandbox isn't ready"
          body={`${failure.reason} Agents run only inside the sandbox.`}
          action={
            <Button onClick={() => openPrefs("agent-sandbox")}>
              Agent sandbox
            </Button>
          }
        />
      );
    case "signIn":
      return (
        <State
          kind={failure.kind}
          title={`Sign in to ${failure.agent}`}
          body={
            failure.hint
              ? `${failure.agent} needs you to sign in. ${failure.hint}`
              : `${failure.agent} needs you to sign in.`
          }
          action={retry("Try again")}
        />
      );
    case "notInstalled":
      return (
        <State
          kind={failure.kind}
          title={`${failure.agent} is not installed`}
          body={`Install ${failure.agent}, then check again. SkoposIDE runs the agent CLIs you install.`}
          action={retry("Check again")}
        />
      );
    case "doesNotStart":
      return (
        <State
          kind={failure.kind}
          title={`${failure.agent} doesn't start`}
          body={failure.reason}
          action={retry("Check again")}
        />
      );
    case "other":
      return (
        <State
          kind={failure.kind}
          title="The chat could not start"
          body={failure.message}
          action={retry("Try again")}
        />
      );
  }
}

/** A new chat (spec §3.3): the title, three suggestions that send, and the notes line. */
export function NewChatView() {
  const scope = useAgentChat((s) => s.scope);
  const settings = useAgentChat((s) => s.clusterSettings);
  const clusters = useCatalog((s) => s.clusters);
  const global = scope?.global ?? true;
  const clusterId = !global ? scope?.clusters[0] : undefined;
  const hasNotes =
    clusterId !== undefined && (settings?.notes.trim() ?? "") !== "";
  return (
    <div className={styles.newChat}>
      <span className={styles.sparkles}>
        <Sparkles size={24} aria-hidden="true" />
      </span>
      <h3 className={styles.newTitle} data-testid="agent-new-chat-title">
        Ask the agent
      </h3>
      <div className={styles.suggestions}>
        {(global ? GLOBAL_SUGGESTIONS : CLUSTER_SUGGESTIONS).map((text) => (
          <Button
            key={text}
            variant="secondary"
            size="sm"
            className={styles.suggestion}
            onClick={() => void useAgentChat.getState().send(text)}
            data-testid="agent-suggestion"
          >
            {text}
          </Button>
        ))}
      </div>
      {hasNotes && scope ? (
        <p className={styles.notes}>
          {`Your notes for ${scopeLabel(scope, clusters)} go with every chat.`}{" "}
          <button
            type="button"
            className={styles.link}
            onClick={() =>
              openPath(settingsPath(clusterId, "agent"), "current")
            }
          >
            Edit
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** In place of the composer when a stored chat cannot continue (spec §3.4). */
export function ReopenBar(props: { agent: string; onNewChat(): void }) {
  return (
    <div className={styles.reopen} role="status" data-testid="agent-reopen">
      <span>{`${props.agent} can't reopen old chats. Start a new chat to continue.`}</span>
      <Button size="sm" onClick={props.onNewChat}>
        New chat
      </Button>
    </div>
  );
}

/** Above the composer while the chat's one cluster is not connected (spec §3.3). */
export function ConnectBanner(props: { clusterId: string }) {
  const entry = useCatalog((s) =>
    s.clusters.find((c) => c.id === props.clusterId),
  );
  const { connect, busy } = useConnect(props.clusterId);
  if (!entry || entry.state.status === "connected") return null;
  const connecting = busy || entry.state.status === "connecting";
  return (
    <div
      className={styles.banner}
      role="status"
      data-testid="agent-connect-banner"
    >
      <span>
        {`${entry.name} is not connected. The agent can't read it until you connect.`}
      </span>
      <Button
        size="sm"
        disabled={connecting}
        onClick={() => void connect()}
        data-testid="agent-connect"
      >
        Connect
      </Button>
    </div>
  );
}
