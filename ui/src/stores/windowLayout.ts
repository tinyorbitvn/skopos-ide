import { create } from "zustand";
import { type LayoutAction, reduce } from "../app/tabs/layout";
import type { WindowLayout } from "../ipc/generated/WindowLayout";
import { MAIN_WINDOW } from "../ipc/window";

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

/** Puts the store back to a fresh window, with `layout` when given, ready. */
export function resetWindowLayoutForTest(layout?: WindowLayout): void {
  const next = layout ?? startLayout(MAIN_WINDOW);
  useWindowLayout.setState({ label: next.label, layout: next, ready: true });
}
