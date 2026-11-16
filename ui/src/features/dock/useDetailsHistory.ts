import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DrawerTarget, targetKey } from "../../kinds/detail/links";
import type { KubeObject } from "../../kinds/objects";
import {
  type DetailsDockTab,
  readDraft,
  useDock,
  writeDraft,
} from "../../stores/dock";
import {
  type DrawerEntry,
  type DrawerHistory,
  goBack,
  previousEntry,
  pushTarget,
  setTab as setEntryTab,
  shownEntry,
} from "../details/drawerHistory";
import type { DrawerHistoryApi } from "../details/useDrawerHistory";

/** The object a details tab was opened for: the root of its history (spec K11). */
export function detailsRoot(tab: DetailsDockTab): DrawerTarget {
  return {
    group: tab.resource.group,
    plural: tab.resource.plural,
    namespace: tab.namespace,
    name: tab.name,
  };
}

/**
 * The entries after the root, kept as the tab's draft: a cluster switch unmounts the
 * panel, and the steps have to be there when it comes back. They go with the tab and
 * are never saved (spec K11).
 */
function readLinked(id: string): DrawerEntry[] {
  return readDraft<DrawerEntry[]>(id) ?? [];
}

/** The entry a details tab shows: its last linked one, or its root on the saved tab (spec K15). */
export function shownDetailsEntry(tab: DetailsDockTab): DrawerEntry {
  return (
    readLinked(tab.id).at(-1) ?? { target: detailsRoot(tab), tab: tab.tab }
  );
}

/**
 * A details tab's back history, built from `drawerHistory.ts` as the drawer's is (spec
 * K11): at most 20 entries, the root kept, and Back restores the earlier tab. The root's
 * tab is the tab's saved `tab`. Opening the tab's object again replaces the tab (spec
 * K4), which starts the history over from the draft that `open` cleared.
 */
export function useDetailsHistory(tab: DetailsDockTab): DrawerHistoryApi {
  const { id, namespace, name } = tab;
  const { group, plural } = tab.resource;
  const root = useMemo<DrawerTarget>(
    () => ({ group, plural, namespace, name }),
    [group, plural, namespace, name],
  );
  const rootEntry = useMemo<DrawerEntry>(
    () => ({ target: root, tab: tab.tab }),
    [root, tab.tab],
  );
  const [state, setState] = useState(() => ({
    owner: tab,
    linked: readLinked(id),
    step: 0,
  }));
  let linked = state.linked;
  // A replaced tab starts over from its draft, with no render showing the old steps.
  if (state.owner !== tab) {
    linked = readLinked(id);
    setState({ owner: tab, linked, step: state.step });
  }
  useEffect(() => {
    writeDraft(id, linked);
  }, [id, linked]);

  const entries = useMemo(() => [rootEntry, ...linked], [rootEntry, linked]);
  const history: DrawerHistory = { entries };
  const seen = useRef(new Map<string, KubeObject>());

  const move = useCallback(
    (change: (h: DrawerHistory) => DrawerHistory) =>
      setState((s) => ({
        ...s,
        linked: change({ entries: [rootEntry, ...s.linked] }).entries.slice(1),
        step: s.step + 1,
      })),
    [rootEntry],
  );
  const open = useCallback(
    (target: DrawerTarget) => move((h) => pushTarget(h, target)),
    [move],
  );
  const back = useCallback(() => move(goBack), [move]);
  const atRoot = linked.length === 0;
  const setTab = useCallback(
    (next: string) => {
      // The root's tab is saved with the tab (spec K9); a linked entry's is not.
      if (atRoot) {
        useDock.getState().setDetailsTab(id, next);
        return;
      }
      setState((s) => ({
        ...s,
        linked: setEntryTab(
          { entries: [rootEntry, ...s.linked] },
          next,
        ).entries.slice(1),
      }));
    },
    [atRoot, id, rootEntry],
  );
  const reset = useCallback(() => setState((s) => ({ ...s, linked: [] })), []);
  const lastSeen = useCallback(
    (target: DrawerTarget) => seen.current.get(targetKey(target)) ?? null,
    [],
  );
  const remember = useCallback(
    (target: DrawerTarget, object: KubeObject) => {
      const keep = new Set(entries.map((e) => targetKey(e.target)));
      for (const key of seen.current.keys()) {
        if (!keep.has(key)) seen.current.delete(key);
      }
      seen.current.set(targetKey(target), object);
    },
    [entries],
  );

  return {
    root,
    shown: shownEntry(history),
    previous: previousEntry(history),
    step: state.step,
    open,
    back,
    setTab,
    reset,
    lastSeen,
    remember,
  };
}
