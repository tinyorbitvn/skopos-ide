import { create } from "zustand";
import { type LayoutAction, prune, reduce } from "../app/tabs/layout";
import { api } from "../ipc/api";
import { events } from "../ipc/events";
import type { WindowLayout } from "../ipc/generated/WindowLayout";
import { MAIN_WINDOW, windowLabel } from "../ipc/window";

export interface WindowLayoutState {
  /** This window's label (spec P32). */
  label: string;
  /** Its panes and tabs (spec P38). */
  layout: WindowLayout;
  /** True once the layout came from the core, or the core could not give one. */
  ready: boolean;
  /** Applies a layout change; a refused or empty change leaves the state as it is. */
  dispatch(action: LayoutAction): void;
}

/** One pane with one Catalog tab, as the core starts a window (spec P39). */
export function startLayout(label: string): WindowLayout {
  const tab = crypto.randomUUID();
  return {
    label,
    bounds: null,
    panes: [
      {
        id: crypto.randomUUID(),
        width: 1,
        selected: tab,
        tabs: [{ id: tab, pinned: false, history: ["/catalog"], index: 0 }],
      },
    ],
    focusedPane: 0,
  };
}

export const useWindowLayout = create<WindowLayoutState>()((set, get) => ({
  label: MAIN_WINDOW,
  layout: startLayout(MAIN_WINDOW),
  ready: false,
  dispatch(action) {
    const previous = get().layout;
    const next = reduce(previous, action);
    if (next !== previous) set({ layout: next });
  },
}));

/** A change is saved this long after the last one (spec P38). */
export const LAYOUT_SAVE_DELAY_MS = 300;

let started: Promise<void> | null = null;
let stops: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let unsaved: WindowLayout | null = null;
/** True while the core's layout is put in place, which is not saved back. */
let applying = false;

function hasTabs(layout: WindowLayout): boolean {
  return layout.panes.some((p) => p.tabs.length > 0);
}

function cancelSave(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  unsaved = null;
}

/**
 * Sends the change waiting to be saved now. Call it before a tab moves to another
 * window, so a late save cannot undo the move.
 */
export function flushWindowLayout(): Promise<void> {
  const layout = unsaved;
  cancelSave();
  if (layout === null) return Promise.resolve();
  // A refused save (the window closed meanwhile) has nothing to undo, and the core
  // reports its own failures to write the file.
  return api.windowLayoutSet(layout).catch(() => {});
}

function queueSave(layout: WindowLayout): void {
  cancelSave();
  unsaved = layout;
  // A window other than main closes once a save leaves it without tabs (P21), so
  // that save does not wait.
  if (layout.label !== MAIN_WINDOW && !hasTabs(layout)) {
    void flushWindowLayout();
    return;
  }
  timer = setTimeout(() => void flushWindowLayout(), LAYOUT_SAVE_DELAY_MS);
}

/**
 * Loads this window's layout from the core, drops the tabs no route knows and sends
 * the result back (P39), then keeps it in sync: each change is saved after 300 ms and
 * at once on `pagehide`, and a layout the core sends replaces this one (P38). The
 * listener is in place before the layout is asked for, so a layout the core sends
 * meanwhile (a tab moved in while the window loads) is kept, and the newest one wins
 * over the answer. Runs once per page; later calls return the first one's promise.
 */
export function startWindowLayout(
  isRoute: (path: string) => boolean,
): Promise<void> {
  started ??= (async () => {
    const label = windowLabel();
    let loading = true;
    let sentMeanwhile: WindowLayout | null = null;
    const unlisten = await events.onWindowLayout((incoming) => {
      if (loading) {
        sentMeanwhile = incoming;
        return;
      }
      cancelSave();
      const kept = prune(incoming, isRoute);
      applying = true;
      try {
        useWindowLayout.setState({ layout: kept });
      } finally {
        applying = false;
      }
      if (kept !== incoming) queueSave(kept);
    });
    stops.push(unlisten);

    let answer: WindowLayout;
    try {
      answer = await api.windowLayoutGet();
    } catch {
      answer = startLayout(label);
    }
    loading = false;
    const loaded = sentMeanwhile ?? answer;
    const layout = prune(loaded, isRoute);
    useWindowLayout.setState({ label, layout, ready: true });
    if (layout !== loaded) void api.windowLayoutSet(layout).catch(() => {});

    stops.push(
      useWindowLayout.subscribe((state, previous) => {
        if (state.layout !== previous.layout && !applying) {
          queueSave(state.layout);
        }
      }),
    );
    const onPageHide = () => void flushWindowLayout();
    window.addEventListener("pagehide", onPageHide);
    stops.push(() => window.removeEventListener("pagehide", onPageHide));
  })();
  return started;
}

/** Puts the store back to a fresh window, with `layout` when given, ready, and stops syncing. */
export function resetWindowLayoutForTest(layout?: WindowLayout): void {
  for (const stop of stops) stop();
  stops = [];
  started = null;
  cancelSave();
  applying = false;
  const next = layout ?? startLayout(MAIN_WINDOW);
  useWindowLayout.setState({ label: next.label, layout: next, ready: true });
}
