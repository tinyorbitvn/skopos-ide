import { create } from "zustand";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import { flushWindowLayout, useWindowLayout } from "../../stores/windowLayout";
import {
  DRAG_THRESHOLD,
  type DropOver,
  outsideWindow,
  overAt,
  targetAt,
} from "./drag";

/** A tab being dragged. */
export interface TabDrag {
  tabId: string;
  /** Its full title, shown beside the pointer. */
  title: string;
  /** The pointer, in client pixels. */
  x: number;
  y: number;
  /** What letting go there does; null cancels. */
  over: DropOver | null;
}

export const useTabDrag = create<{ drag: TabDrag | null }>()(() => ({
  drag: null,
}));

/**
 * Moves a tab let go outside the window into the window under that screen point, or
 * into a new window there (spec P31). The pending save goes first, so it cannot put
 * the tab back. A failure says why in a toast, and the tab stays (P44).
 */
export async function dropOutside(
  tabId: string,
  screenX: number,
  screenY: number,
): Promise<void> {
  await flushWindowLayout();
  try {
    await api.windowTabDrop(tabId, screenX, screenY);
  } catch (error) {
    toast.error(failureMessage(error));
  }
}

/** The click a release ends with must not select the tab under it. */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

function sameOver(a: DropOver | null, b: DropOver | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Drags a tab from a press on it (spec P22): a move of `DRAG_THRESHOLD` px starts the
 * drag; over a strip or a body zone, letting go changes the layout; outside the
 * window it moves the tab to another window (P31); anywhere else, Esc, a cancelled
 * pointer or a lost focus cancel. The listeners sit on `window`, without pointer
 * capture, so the release outside the window still arrives where the platform sends
 * it there.
 */
export function startTabDrag(
  press: PointerEvent,
  tabId: string,
  title: string,
): void {
  if (press.button !== 0) return;
  const fromX = press.clientX;
  const fromY = press.clientY;
  const newPaneId = crypto.randomUUID();
  let live = false;

  function overFor(x: number, y: number): DropOver | null {
    if (outsideWindow(x, y)) return { kind: "outside" };
    const { layout } = useWindowLayout.getState();
    const target = targetAt(document.elementFromPoint(x, y), x);
    return overAt(layout, tabId, target, newPaneId);
  }

  function show(x: number, y: number): void {
    const before = useTabDrag.getState().drag;
    const over = overFor(x, y);
    useTabDrag.setState({
      drag: {
        tabId,
        title,
        x,
        y,
        // The same object while it means the same, so the panes do not redraw.
        over:
          before !== null && sameOver(before.over, over) ? before.over : over,
      },
    });
  }

  function stop(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("blur", stop);
    window.removeEventListener("keydown", onKey, true);
    if (useTabDrag.getState().drag !== null)
      useTabDrag.setState({ drag: null });
  }

  function onMove(event: PointerEvent): void {
    if (event.pointerId !== press.pointerId) return;
    if (!live) {
      const moved = Math.hypot(event.clientX - fromX, event.clientY - fromY);
      if (moved < DRAG_THRESHOLD) return;
      live = true;
    } else if (event.buttons === 0) {
      // The release happened where it was not reported.
      stop();
      return;
    }
    show(event.clientX, event.clientY);
  }

  function onUp(event: PointerEvent): void {
    if (event.pointerId !== press.pointerId) return;
    stop();
    if (!live) return;
    swallowNextClick();
    const over = overFor(event.clientX, event.clientY);
    if (over === null) return;
    if (over.kind === "outside") {
      void dropOutside(tabId, event.screenX, event.screenY);
    } else {
      useWindowLayout.getState().dispatch(over.action);
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (live) {
      event.preventDefault();
      event.stopPropagation();
    }
    stop();
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop);
  window.addEventListener("keydown", onKey, true);
}
