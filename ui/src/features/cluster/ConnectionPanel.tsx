import { useEffect, useState } from "react";
import { Button, Spinner } from "../../design";
import { api } from "../../ipc/api";
import type { ConnectionLogEntry } from "../../ipc/generated/ConnectionLogEntry";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import type { FailureKind } from "../../ipc/generated/FailureKind";
import styles from "./ClusterScreen.module.css";

const HEADINGS: Record<FailureKind, string> = {
  unreachable: "Cannot reach the cluster",
  unauthorized: "Not authorized",
  forbidden: "Access forbidden",
  configInvalid: "Kubeconfig problem",
  execNotAllowed: "Permission needed",
  other: "Connection failed",
};

const LOG_POLL_MS = 500;

/**
 * The connection log of a cluster. It is read again whenever the state
 * changes, and every 500 ms while a connect is running.
 */
function useConnectionLog(
  id: string,
  state: ConnectionState,
): ConnectionLogEntry[] {
  const [log, setLog] = useState<ConnectionLogEntry[]>([]);
  const status = state.status;
  // The state is a dependency so each `cluster://state` change reads again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    let alive = true;
    const read = () => {
      api
        .clusterLog(id)
        .then((entries) => {
          if (alive) setLog(entries);
        })
        .catch(() => {});
    };
    read();
    if (status !== "connecting") {
      return () => {
        alive = false;
      };
    }
    const timer = setInterval(read, LOG_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, state, status]);
  return log;
}

export function ConnectionPanel(props: {
  id: string;
  state: ConnectionState;
  busy: boolean;
  /** True after the user disconnected: the button then reads Reconnect. */
  reconnect: boolean;
  onConnect(): void;
  onDisconnect(): void;
}) {
  const { state } = props;
  const log = useConnectionLog(props.id, state);
  const again = state.status === "failed" || props.reconnect;
  // The kubeconfig waits for permission to run a program: connecting again asks.
  const review = state.status === "failed" && state.kind === "execNotAllowed";
  const connectId = review
    ? "cluster-review-exec"
    : again
      ? "cluster-reconnect"
      : "cluster-connect";
  const connectLabel = review
    ? "Review and allow"
    : again
      ? "Reconnect"
      : "Connect";

  return (
    <section className={styles.panel} aria-label="Connection">
      {state.status === "connecting" ? (
        <div className={styles.busy}>
          <Spinner label="Connecting" />
          <Button
            size="sm"
            data-testid="cluster-disconnect"
            onClick={props.onDisconnect}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {state.status === "failed" ? (
        <>
          <h3 className={styles.heading}>{HEADINGS[state.kind]}</h3>
          <p className={styles.message}>{state.message}</p>
        </>
      ) : null}
      {state.status === "disconnected" ? (
        <p className={styles.message}>Not connected.</p>
      ) : null}
      {state.status === "failed" || state.status === "disconnected" ? (
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={props.busy}
            data-testid={connectId}
            onClick={props.onConnect}
          >
            {connectLabel}
          </Button>
        </div>
      ) : null}
      <ul className={styles.log} data-testid="connection-log" aria-label="Log">
        {log.map((entry) => (
          <li
            key={`${entry.tsMs}-${entry.message}`}
            className={styles[entry.level]}
          >
            {entry.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
