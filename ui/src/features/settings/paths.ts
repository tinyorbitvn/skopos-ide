/** The cluster's Overview, the index route of `cluster/:id`. */
export function overviewPath(clusterId: string): string {
  return `/cluster/${encodeURIComponent(clusterId)}`;
}

/** The cluster's Settings page, which opens whether or not the cluster is connected.
 * `card: "agent"` scrolls to the Agent card (agents spec §3.1, P14). */
export function settingsPath(clusterId: string, card?: "agent"): string {
  const path = `${overviewPath(clusterId)}/settings`;
  return card ? `${path}?card=${card}` : path;
}

/** The Agent card's element id. */
export const AGENT_CARD_ID = "settings-agent";
