import type { Tone } from "../design/Badge";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import type { TunnelView } from "../ipc/generated/TunnelView";
import { tunnelOf } from "../stores/tunnels";

/** The badge a connected cluster shows while its tunnel is down (tunnels spec §5.1). */
export interface TunnelProblem {
  label: string;
  tone: Tone;
  /** The tunnel's name and the reason, for the tooltip. */
  detail: string;
}

/**
 * What to show beside a connected cluster whose tunnel failed. A proxy tunnel is only ever
 * `failed` among the states that need a badge; phase 2 adds `reconnecting` and `needsInput`.
 */
export function tunnelProblem(
  cluster: Pick<ClusterEntry, "state" | "tunnel">,
  tunnels: TunnelView[] | null,
): TunnelProblem | null {
  if (cluster.state.status !== "connected") return null;
  const tunnel = tunnelOf(tunnels, cluster.tunnel);
  if (tunnel === null) return null;
  const { state } = tunnel;
  if (state.status !== "failed") return null;
  return {
    label: "Tunnel failed",
    tone: "danger",
    detail: `Tunnel "${tunnel.name}": ${state.message}`,
  };
}
