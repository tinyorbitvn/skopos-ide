import type { Tone } from "../design/Badge";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";

/** Something a cluster's kubeconfig does on connect that is worth knowing beforehand. */
export interface ConnectionNote {
  id: "exec" | "tls";
  label: string;
  tone: Tone;
  detail: string;
}

/**
 * What to tell about a cluster before it is connected, the warning first. An exec plugin
 * is ordinary, so it is named without a warning; a kubeconfig that turns TLS verification
 * off is not.
 */
export function connectionNotes(
  cluster: Pick<ClusterEntry, "execCommand" | "insecureTls">,
): ConnectionNote[] {
  const notes: ConnectionNote[] = [];
  if (cluster.insecureTls) {
    notes.push({
      id: "tls",
      label: "TLS not verified",
      tone: "warn",
      detail:
        "This kubeconfig turns off TLS verification (insecure-skip-tls-verify), so the server's identity is not checked.",
    });
  }
  if (cluster.execCommand !== null) {
    notes.push({
      id: "exec",
      label: "Exec plugin",
      tone: "neutral",
      detail: `Connecting runs "${cluster.execCommand}" from this kubeconfig to get credentials.`,
    });
  }
  return notes;
}
