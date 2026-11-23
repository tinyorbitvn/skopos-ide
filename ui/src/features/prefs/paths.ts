/** The agent sections of Preferences that other pages open (agents spec §3.1, §3.3). */
export type PrefsSection = "agents" | "agent-sandbox" | "agent-changes";

/** Preferences, scrolled to `section` when one is given (P14). */
export function prefsPath(section?: PrefsSection): string {
  return section ? `/preferences?section=${section}` : "/preferences";
}

/** The id of a section's element. */
export function prefsSectionId(section: PrefsSection): string {
  return `prefs-${section}`;
}
