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
import { useTunnels } from "../../stores/tunnels";
import styles from "./PreferencesScreen.module.css";
import { TunnelDeleteDialog, TunnelDialog } from "./TunnelDialogs";
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

/** Preferences › Tunnels (tunnels spec §5.1). */
export function TunnelsSection() {
  const { hash } = useLocation();
  const tunnels = useTunnels((s) => s.tunnels);
  const error = useTunnels((s) => s.error);
  const load = useTunnels((s) => s.load);
  const retry = useTunnels((s) => s.retry);
  const [editing, setEditing] = useState<TunnelView | "new" | null>(null);
  const [deleting, setDeleting] = useState<TunnelView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (hash === `#${TUNNELS_ANCHOR}`) {
      ref.current?.scrollIntoView({ block: "start" });
    }
  }, [hash]);

  async function test(t: TunnelView): Promise<void> {
    setTesting(t.id);
    try {
      const view = await api.tunnelTest(t.id);
      if (view.state.status === "failed") {
        toast.error(`Tunnel "${t.name}" failed`, view.state.message);
      } else {
        toast.success(`Tunnel "${t.name}" is up`);
      }
    } catch (failure) {
      toast.error(`Tunnel "${t.name}" failed`, failureMessage(failure));
    } finally {
      setTesting(null);
    }
  }

  async function stop(t: TunnelView): Promise<void> {
    try {
      await api.tunnelStop(t.id);
    } catch (failure) {
      toast.error(`Could not stop tunnel "${t.name}"`, failureMessage(failure));
    }
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
            className={styles.row}
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
            {t.state.status === "up" || t.state.status === "starting" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void stop(t);
                }}
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
    </section>
  );
}
