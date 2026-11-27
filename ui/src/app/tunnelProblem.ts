import type { Tone } from "../design/Badge";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import type { TunnelView } from "../ipc/generated/TunnelView";
import { tunnelOf } from "../stores/tunnels";

/** The badge a connected cluster shows while its tunnel is not up (tunnels spec §5.1). */
export interface TunnelProblem {
  label: string;
  tone: Tone;
  /** The tunnel's name and the reason, for the tooltip. */
  detail: string;
  /** Set while the tunnel waits for an answer: the badge opens that prompt (spec §6.1). */
  promptId: string | null;
}

/** What to show beside a connected cluster whose tunnel is reconnecting, waits or failed. */
export function tunnelProblem(
  cluster: Pick<ClusterEntry, "state" | "tunnel">,
  tunnels: TunnelView[] | null,
): TunnelProblem | null {
  if (cluster.state.status !== "connected") return null;
  const tunnel = tunnelOf(tunnels, cluster.tunnel);
  if (tunnel === null) return null;
  const { state } = tunnel;
  const name = `Tunnel "${tunnel.name}"`;
  switch (state.status) {
    case "reconnecting":
      return {
        label: "Tunnel reconnecting",
        tone: "warn",
        detail: `${name}: ${state.lastError}`,
        promptId: null,
      };
    case "needsInput":
      return {
        label: "Tunnel needs input",
        tone: "warn",
        detail: `${name} waits for an answer`,
        promptId: state.promptId,
      };
    case "failed":
      return {
        label: "Tunnel failed",
        tone: "danger",
        detail: `${name}: ${state.message}`,
        promptId: null,
      };
    default:
      return null;
  }
}
