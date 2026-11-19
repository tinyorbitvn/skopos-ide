import { useEffect, useState } from "react";
import { StatusDot, useNow } from "../../design";
import type { Tone } from "../../design/Badge";
import { api } from "../../ipc/api";
import type { ControlPlane } from "../../ipc/generated/ControlPlane";
import type { ControlPlaneComponent } from "../../ipc/generated/ControlPlaneComponent";
import type { HealthState } from "../../ipc/generated/HealthState";
import { formatAge } from "../../kinds/objects";
import styles from "./ControlPlane.module.css";

/** How often the Overview asks again while it is open. */
export const CONTROL_PLANE_POLL_MS = 30_000;

const TONE: Record<HealthState, Tone> = {
  healthy: "ok",
  degraded: "warn",
  unhealthy: "danger",
  unknown: "neutral",
};

const LABEL: Record<HealthState, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};

const RANK: Record<HealthState, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  unhealthy: 3,
};

/** The worse of two states; unknown only beats healthy. */
export function worst(a: HealthState, b: HealthState): HealthState {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The read of the control plane, again every 30 s while the Overview is open. */
export function useControlPlane(clusterId: string): {
  value: ControlPlane | null;
  error: string | null;
} {
  const [value, setValue] = useState<ControlPlane | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => {
      api
        .clusterControlPlane(clusterId)
        .then((next) => {
          if (!alive) return;
          setValue(next);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : String(e),
          );
        });
    };
    read();
    const timer = setInterval(read, CONTROL_PLANE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [clusterId]);
  return { value, error };
}

/** What a component's row says after its state: its Pods, its leader, its check. */
export function componentDetail(
  component: ControlPlaneComponent,
  now: number,
): string {
  const parts: string[] = [];
  if (component.pods) {
    const { ready, total } = component.pods;
    parts.push(`${ready} of ${total} ${total === 1 ? "Pod" : "Pods"} ready`);
  }
  if (component.leader) {
    const { holder, renewed } = component.leader;
    const who = holder === "" ? "no leader" : `leader ${holder}`;
    parts.push(
      renewed === null
        ? `${who}, never renewed`
        : `${who}, renewed ${formatAge(renewed, now)} ago`,
    );
  }
  if (component.check !== null) {
    parts.push(component.check ? "readyz check ok" : "readyz check failed");
  }
  if (parts.length === 0) {
    return "Not visible: run by the provider, or not readable with your access";
  }
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Row(props: {
  id: string;
  name: string;
  state: HealthState;
  detail: string;
}) {
  return (
    <li className={styles.row} data-testid={`control-plane-${props.id}`}>
      <StatusDot tone={TONE[props.state]} label={LABEL[props.state]} />
      <span className={styles.name}>{props.name}</span>
      <span
        className={styles.state}
        data-testid={`control-plane-${props.id}-state`}
      >
        {LABEL[props.state]}
      </span>
      <span
        className={styles.detail}
        data-testid={`control-plane-${props.id}-detail`}
      >
        {props.detail}
      </span>
    </li>
  );
}

/**
 * The Overview's Control plane: the API server with its health checks, then etcd, the
 * scheduler, the controller manager, DNS and kube-proxy, as far as the cluster shows them.
 */
export function ControlPlaneSection(props: { clusterId: string }) {
  const { value, error } = useControlPlane(props.clusterId);
  const now = useNow();
  const [checksOpen, setChecksOpen] = useState(false);

  let body: React.ReactNode;
  if (value === null) {
    body = (
      <p className={styles.note} data-testid="control-plane-note">
        {error === null
          ? "Reading the control plane…"
          : `Could not read the control plane: ${error}`}
      </p>
    );
  } else {
    const server = value.apiServer;
    const failed = server.checks.filter((c) => !c.ok);
    const checks =
      server.checks.length === 0
        ? null
        : failed.length === 0
          ? `all ${server.checks.length} readyz checks pass`
          : `${failed.length} of ${server.checks.length} readyz checks fail: ${failed
              .map((c) => c.name)
              .join(", ")}`;
    const serverDetail = [server.version, server.url, checks]
      .filter(Boolean)
      .join(" · ");
    body = (
      <>
        <ul className={styles.list}>
          <Row
            id="api-server"
            name="API server"
            state={worst(server.live, server.ready)}
            detail={serverDetail}
          />
          {value.components.map((c) => (
            <Row
              key={c.id}
              id={c.id}
              name={c.name}
              state={c.state}
              detail={componentDetail(c, now)}
            />
          ))}
        </ul>
        {server.checks.length > 0 ? (
          <details
            className={styles.checks}
            open={checksOpen}
            onToggle={(e) => setChecksOpen(e.currentTarget.open)}
          >
            <summary data-testid="control-plane-checks-toggle">
              readyz checks
            </summary>
            <ul className={styles.checkList} data-testid="control-plane-checks">
              {server.checks.map((c) => (
                <li key={c.name}>
                  <StatusDot
                    tone={c.ok ? "ok" : "danger"}
                    label={c.ok ? "ok" : "failed"}
                  />
                  <span className={styles.mono}>{c.name}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {server.platform || server.buildDate || server.goVersion ? (
          <p className={styles.note} data-testid="control-plane-build">
            {[
              server.platform,
              server.goVersion,
              server.buildDate ? `built ${server.buildDate}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <section
      className={styles.section}
      aria-labelledby="control-plane-title"
      data-testid="control-plane"
    >
      <h2 id="control-plane-title" className={styles.title}>
        Control plane
      </h2>
      {body}
    </section>
  );
}
