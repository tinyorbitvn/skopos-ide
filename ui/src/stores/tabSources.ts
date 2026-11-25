import type { EditorTab } from "../ipc/generated/EditorTab";

/** A YAML tab as a prompt carries it, read when the prompt is sent (spec A6). */
export type TabSource = () => Promise<EditorTab>;

const sources = new Map<string, TabSource>();

/** Registers an open tab; the returned function removes it again. */
export function registerTabSource(
  tabId: string,
  source: TabSource,
): () => void {
  sources.set(tabId, source);
  return () => {
    if (sources.get(tabId) === source) sources.delete(tabId);
  };
}

export function tabSource(tabId: string): TabSource | null {
  return sources.get(tabId) ?? null;
}

/** Removes a closed tab; true when it was a YAML tab. */
export function dropTabSource(tabId: string): boolean {
  return sources.delete(tabId);
}

export function resetTabSourcesForTest(): void {
  sources.clear();
}
