import { type DrawerTarget, targetKey } from "../../kinds/detail/links";

/** The tab every entry starts on. */
export const OVERVIEW = "overview";
/** At most this many entries; a push past it drops the entry after the root. */
export const MAX_ENTRIES = 20;

export interface DrawerEntry {
  target: DrawerTarget;
  tab: string;
}

/** The drawer's back history: `entries[0]` is the root, the last one is shown. */
export interface DrawerHistory {
  entries: DrawerEntry[];
}

export function startHistory(
  root: DrawerTarget | null,
  tab = OVERVIEW,
): DrawerHistory {
  return { entries: root ? [{ target: root, tab }] : [] };
}

/** The drawer's tabs. An object is offered the ones that fit it (spec H46). */
export const DRAWER_TABS: readonly string[] = [
  OVERVIEW,
  "metrics",
  "map",
  "events",
];

/** The router state with which Open as drawer asks for a tab (spec K14, K16). */
export interface DrawerRouteState {
  drawerTab: string;
}

/** The drawer tab `state` asks for, or null when it asks for none or for no drawer tab. */
export function drawerTabOf(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const tab = (state as { drawerTab?: unknown }).drawerTab;
  return typeof tab === "string" && DRAWER_TABS.includes(tab) ? tab : null;
}

export function shownEntry(h: DrawerHistory): DrawerEntry | null {
  return h.entries.at(-1) ?? null;
}

export function previousEntry(h: DrawerHistory): DrawerEntry | null {
  return h.entries.length > 1 ? h.entries[h.entries.length - 2] : null;
}

/** Shows `target` on its Overview; no change when it is already shown or nothing is open. */
export function pushTarget(
  h: DrawerHistory,
  target: DrawerTarget,
): DrawerHistory {
  const shown = shownEntry(h);
  if (shown === null || targetKey(shown.target) === targetKey(target)) return h;
  const entries = [...h.entries, { target, tab: OVERVIEW }];
  if (entries.length > MAX_ENTRIES) entries.splice(1, 1);
  return { entries };
}

/** Pops the shown entry; no change at the root. */
export function goBack(h: DrawerHistory): DrawerHistory {
  return h.entries.length > 1 ? { entries: h.entries.slice(0, -1) } : h;
}

/** The shown entry's tab. */
export function setTab(h: DrawerHistory, tab: string): DrawerHistory {
  const shown = shownEntry(h);
  if (shown === null || shown.tab === tab) return h;
  return { entries: [...h.entries.slice(0, -1), { ...shown, tab }] };
}
