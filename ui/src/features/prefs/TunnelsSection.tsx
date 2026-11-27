import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Spinner,
  toast,
} from "../../design";
import type { Tone } from "../../design/Badge";
import { Plus } from "../../design/icons";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { TunnelState } from "../../ipc/generated/TunnelState";
import type { TunnelView } from "../../ipc/generated/TunnelView";
import { useCatalog } from "../../stores/catalog";
import { useTunnels } from "../../stores/tunnels";
import styles from "./PreferencesScreen.module.css";
import {
  TunnelDeleteDialog,
  TunnelDialog,
  TunnelStopDialog,
} from "./TunnelDialogs";
import { targetText } from "./tunnelForm";

/** The anchor cluster settings and a failed connect open Preferences at. */
export const TUNNELS_ANCHOR = "tunnels";

const STATES: Record<TunnelState["status"], { label: string; tone: Tone }> = {
  idle: { label: "Idle", tone: "neutral" },
  starting: { label: "Starting", tone: "info" },
  up: { label: "Up", tone: "ok" },
  reconnecting: { label: "Reconnecting", tone: "warn" },
  needsInput: { label: "Needs input", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
};

/** While `ssh` runs or the gateway may carry connections: `Stop` shows. */
const RUNNING: TunnelState["status"][] = [
  "starting",
  "up",
  "reconnecting",
  "needsInput",
];

function usedBy(count: number): string {
  if (count === 0) return "No cluster uses it";
  return count === 1 ? "Used by 1 cluster" : `Used by ${count} clusters`;
}

function stateReason(state: TunnelState): string | undefined {
  if (state.status === "failed") return state.message;
  if (state.status === "reconnecting") return state.lastError;
  return undefined;
}

function StateBadge(props: { state: TunnelState }) {
  const { label, tone } = STATES[props.state.status];
  return (
    <span title={stateReason(props.state)}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

/** The last lines `ssh` wrote to stderr (tunnels spec §6.1). */
function TunnelLog(props: { tunnel: TunnelView }) {
  const { tunnel } = props;
  return (
    <details
      className={styles.log}
      data-testid={`prefs-tunnel-log-${tunnel.id}`}
    >
      <summary>Log</summary>
      {tunnel.log.length === 0 ? (
        <p className={styles.muted}>No output from ssh yet</p>
      ) : (
        <pre className={styles.logLines}>{tunnel.log.join("\n")}</pre>
      )}
    </details>
  );
}

/** Preferences › Tunnels (tunnels spec §5.1, §6.1). */
export function TunnelsSection() {
  const { hash } = useLocation();
  const tunnels = useTunnels((s) => s.tunnels);
  const error = useTunnels((s) => s.error);
  const load = useTunnels((s) => s.load);
  const retry = useTunnels((s) => s.retry);
  const clusters = useCatalog((s) => s.clusters);
  const [editing, setEditing] = useState<TunnelView | "new" | null>(null);
  const [deleting, setDeleting] = useState<TunnelView | null>(null);
  const [stopping, setStopping] = useState<TunnelView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (hash === `#${TUNNELS_ANCHOR}`) {
      ref.current?.scrollIntoView({ block: "start" });
    }
  }, [hash]);

  /** The connected or connecting clusters `Stop` disconnects. */
  function connectedUsers(t: TunnelView): string[] {
    return clusters
      .filter(
        (c) =>
          c.tunnel === t.id &&
          (c.state.status === "connected" || c.state.status === "connecting"),
      )
      .map((c) => c.name);
  }

  function toastOutcome(t: TunnelView, view: TunnelView): void {
    if (view.state.status === "failed") {
      toast.error(`Tunnel "${t.name}" failed`, view.state.message);
    } else if (view.state.status === "up") {
      toast.success(`Tunnel "${t.name}" is up`);
    }
  }

  async function test(t: TunnelView): Promise<void> {
    setTesting(t.id);
    try {
      toastOutcome(t, await api.tunnelTest(t.id));
    } catch (failure) {
      toast.error(`Tunnel "${t.name}" failed`, failureMessage(failure));
    } finally {
      setTesting(null);
    }
  }

  async function start(t: TunnelView): Promise<void> {
    setStarting(t.id);
    try {
      toastOutcome(t, await api.tunnelStart(t.id));
    } catch (failure) {
      toast.error(
        `Could not start tunnel "${t.name}"`,
        failureMessage(failure),
      );
    } finally {
      setStarting(null);
    }
  }

  async function stop(t: TunnelView): Promise<void> {
    try {
      await api.tunnelStop(t.id);
    } catch (failure) {
      toast.error(`Could not stop tunnel "${t.name}"`, failureMessage(failure));
    }
  }

  function askStop(t: TunnelView): void {
    if (connectedUsers(t).length > 0) setStopping(t);
    else void stop(t);
  }

  let body = null;
  if (tunnels === null && error !== null) {
    body = (
      <ErrorNotice
        title="Could not read the tunnels"
        message={error}
        onRetry={() => {
          void retry();
        }}
      />
    );
  } else if (tunnels === null) {
    body = <Spinner />;
  } else if (tunnels.length === 0) {
    body = (
      <div data-testid="prefs-tunnels-empty">
        <EmptyState title="No tunnels. Add one to reach clusters behind a proxy or a bastion host" />
      </div>
    );
  } else {
    body = (
      <ul className={styles.rows}>
        {tunnels.map((t) => (
          <li
            key={t.id}
            className={`${styles.row} ${styles.tunnelRow}`}
            data-testid={`prefs-tunnel-${t.id}`}
          >
            <span className={styles.repoName}>{t.name}</span>
            <span className={styles.path} title={targetText(t.kind)}>
              {targetText(t.kind)}
            </span>
            <StateBadge state={t.state} />
            <span className={styles.muted}>{usedBy(t.clusterCount)}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(t)}
              data-testid={`prefs-tunnel-edit-${t.id}`}
            >
              Edit…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={testing === t.id}
              onClick={() => {
                void test(t);
              }}
              data-testid={`prefs-tunnel-test-${t.id}`}
            >
              Test connection
            </Button>
            {t.kind.type === "ssh" &&
            (t.state.status === "idle" || t.state.status === "failed") ? (
              <Button
                size="sm"
                variant="ghost"
                loading={starting === t.id}
                onClick={() => {
                  void start(t);
                }}
                data-testid={`prefs-tunnel-start-${t.id}`}
              >
                Start
              </Button>
            ) : null}
            {RUNNING.includes(t.state.status) ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => askStop(t)}
                data-testid={`prefs-tunnel-stop-${t.id}`}
              >
                Stop
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleting(t)}
              data-testid={`prefs-tunnel-delete-${t.id}`}
            >
              Delete…
            </Button>
            {t.kind.type === "ssh" ? <TunnelLog tunnel={t} /> : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section
      ref={ref}
      id={TUNNELS_ANCHOR}
      className={styles.section}
      data-testid="prefs-tunnels"
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>
          <h3 className={styles.heading}>Tunnels</h3>
          <p className={styles.muted}>
            A cluster picks its tunnel in its settings. helm, the cluster's
            terminal and metrics go through it too.
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => setEditing("new")}
          data-testid="prefs-tunnels-add"
        >
          <Plus size={14} aria-hidden="true" />
          Add tunnel…
        </Button>
      </div>
      {body}
      {editing !== null ? (
        <TunnelDialog
          tunnel={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting !== null ? (
        <TunnelDeleteDialog
          tunnel={deleting}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {stopping !== null ? (
        <TunnelStopDialog
          tunnel={stopping}
          clusters={connectedUsers(stopping)}
          onConfirm={() => {
            void stop(stopping);
          }}
          onClose={() => setStopping(null)}
        />
      ) : null}
    </section>
  );
}
