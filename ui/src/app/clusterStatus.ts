import type { Tone } from "../design/Badge";
import type { ClusterInfo } from "../ipc/generated/ClusterInfo";
import type { ConnectionState } from "../ipc/generated/ConnectionState";

const STATUS: Record<ConnectionState["status"], { label: string; tone: Tone }> =
  {
    disconnected: { label: "Disconnected", tone: "neutral" },
    connecting: { label: "Connecting", tone: "info" },
    connected: { label: "Connected", tone: "ok" },
    failed: { label: "Failed", tone: "danger" },
  };

export function clusterStatus(state: ConnectionState): {
  label: string;
  tone: Tone;
} {
  return STATUS[state.status];
}

/**
 * A connected cluster's distribution and release as the cluster switcher names them: an
 * empty distribution reads "Kubernetes", and build metadata after a "+" is left out.
 */
export function clusterRelease(info: ClusterInfo): {
  distribution: string;
  version: string;
} {
  return {
    distribution: info.distribution.trim() || "Kubernetes",
    version: info.version.trim().replace(/\+.*$/, ""),
  };
}
