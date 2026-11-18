import { create } from "zustand";
import { DRAG_THRESHOLD } from "../../app/tabs/drag";
import {
  type FolderTree,
  type MoveItem,
  moveProblem,
  placeName,
} from "./folderTree";

/** Where a dragged folder or cluster would land. */
export interface CatalogDropOver {
  /** A folder id, or null for the top level. */
  target: string | null;
  /** Why it cannot go there, or null when letting go moves it. */
  problem: string | null;
  /** The place, as menus name it. */
  place: string;
}

/** A folder or cluster being dragged in the Catalog (spec P29). */
export interface CatalogDrag {
  item: MoveItem;
  /** Its name, shown beside the pointer. */
  name: string;
  /** The pointer, in client pixels. */
  x: number;
  y: number;
  over: CatalogDropOver | null;
}

export const useCatalogDrag = create<{ drag: CatalogDrag | null }>()(() => ({
  drag: null,
}));

/**
 * The target under an element: a folder row's id, null for the "Top level" strip,
 * or undefined over anything else. Targets carry `data-catalog-drop`.
 */
export function dropTargetAt(el: Element | null): string | null | undefined {
  const hit = el?.closest("[data-catalog-drop]");
  if (!hit) return undefined;
  const id = hit.getAttribute("data-catalog-drop");
  return id === "top" || id === null ? null : id;
}

/** The line beside the pointer: what letting go does, or why it cannot. */
export function dropText(over: CatalogDropOver | null): string {
  if (over === null) return "Let go here to cancel";
  return over.problem ?? `Let go to move it into ${over.place}`;
}

/** The click a release ends with must not open the row under it. */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

/**
 * Drags a folder or a cluster from a press on its row (spec P29): a move of
 * `DRAG_THRESHOLD` px starts it; over a folder row or the "Top level" strip that
 * takes it, letting go calls `onDrop`; over one that refuses it, or anywhere else, it
 * cancels, as Esc, a cancelled pointer or a lost focus do. Window listeners, no
 * pointer capture, as the tab drag.
 */
export function startCatalogDrag(
  press: PointerEvent,
  item: MoveItem,
  name: string,
  tree: () => FolderTree,
  onDrop: (item: MoveItem, target: string | null) => void,
): void {
  if (press.button !== 0) return;
  const fromX = press.clientX;
  const fromY = press.clientY;
  let live = false;

  function overAt(x: number, y: number): CatalogDropOver | null {
    const target = dropTargetAt(document.elementFromPoint(x, y));
    if (target === undefined) return null;
    const now = tree();
    return {
      target,
      problem: moveProblem(now, item, target),
      place: placeName(now, target),
    };
  }

  function stop(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("blur", stop);
    window.removeEventListener("keydown", onKey, true);
    if (useCatalogDrag.getState().drag !== null) {
      useCatalogDrag.setState({ drag: null });
    }
  }

  function onMove(event: PointerEvent): void {
    if (event.pointerId !== press.pointerId) return;
    if (event.buttons === 0) {
      // The release happened where it was not reported, before or after the drag
      // started.
      stop();
      return;
    }
    if (!live) {
      const moved = Math.hypot(event.clientX - fromX, event.clientY - fromY);
      if (moved < DRAG_THRESHOLD) return;
      live = true;
    }
    useCatalogDrag.setState({
      drag: {
        item,
        name,
        x: event.clientX,
        y: event.clientY,
        over: overAt(event.clientX, event.clientY),
      },
    });
  }

  function onUp(event: PointerEvent): void {
    if (event.pointerId !== press.pointerId) return;
    stop();
    if (!live) return;
    swallowNextClick();
    const over = overAt(event.clientX, event.clientY);
    if (over !== null && over.problem === null) onDrop(item, over.target);
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
