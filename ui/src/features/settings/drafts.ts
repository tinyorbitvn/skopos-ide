import type { SettingsDraft } from "./settingsForm";

/**
 * The unsaved Settings draft of each cluster, in memory only. The page remounts when its
 * cluster connects or disconnects, since it moves into or out of the cluster layout; a
 * draft kept here survives that. The page drops it once the draft matches the saved
 * settings again: after Save, Reset, or edits that undo themselves.
 */
const drafts = new Map<string, SettingsDraft>();
/** The saved settings each kept draft was edited from. */
const bases = new Map<string, SettingsDraft>();

const AGENT_FIELDS = [
  "agentChanges",
  "agentNamespacesOnly",
  "agentNamespaces",
  "agentSecretValues",
  "agentExec",
  "agentDefault",
  "agentNotes",
] as const;

/**
 * The kept draft over freshly loaded settings. An agent field the person did not edit
 * (it still equals the base) takes the fresh value, so a stricter setting saved elsewhere
 * meanwhile (Preferences, the agent panel) is not written back over.
 */
export function restoredDraft(
  clusterId: string,
  fresh: SettingsDraft,
): SettingsDraft | undefined {
  const kept = drafts.get(clusterId);
  if (kept === undefined) return undefined;
  const base = bases.get(clusterId);
  if (base === undefined) return kept;
  const merged: SettingsDraft = { ...kept };
  for (const field of AGENT_FIELDS) {
    if (kept[field] === base[field]) {
      (merged as unknown as Record<string, unknown>)[field] = fresh[field];
    }
  }
  return merged;
}

export function keptDraft(clusterId: string): SettingsDraft | undefined {
  return drafts.get(clusterId);
}

export function keepDraft(
  clusterId: string,
  draft: SettingsDraft,
  base?: SettingsDraft,
): void {
  drafts.set(clusterId, draft);
  if (base !== undefined) bases.set(clusterId, base);
}

export function dropDraft(clusterId: string): void {
  drafts.delete(clusterId);
  bases.delete(clusterId);
}

export function resetDraftsForTest(): void {
  drafts.clear();
  bases.clear();
}
