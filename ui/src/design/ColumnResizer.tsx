import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./ColumnResizer.module.css";

/** The narrowest and widest a column can be dragged or fitted to. */
export const MIN_COLUMN_PX = 48;
export const MAX_COLUMN_PX = 2000;
/** One arrow press on a column's handle moves its edge this far; with Shift, four times. */
const COLUMN_KEY_STEP = 16;

/** Widths given to columns by their handles, in pixels, by column id. */
export type ColumnWidths = Readonly<Record<string, number>>;

/** A width a column may take: whole pixels between the narrowest and the widest. */
export function columnWidth(px: number): number {
  return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, Math.round(px)));
}

/** The width that fits cells measured at their natural widths: the widest, rounded up. */
export function fitWidth(natural: number[]): number {
  return columnWidth(Math.ceil(Math.max(0, ...natural)));
}

/**
 * The handle on a header cell's right edge: drag it, or use Left and Right (Shift for
 * bigger steps). A double-click, or Enter, fits the column to what it holds.
 */
export function ColumnResizer(props: {
  header: string;
  /** The column's width while it has one given. */
  width: number | undefined;
  /** Where a drag or a key press starts: the column's width now, in pixels. */
  current(handle: HTMLElement): number;
  onResize(width: number): void;
  onFit(): void;
  testId: string;
}) {
  const { onResize, onFit } = props;
  const [active, setActive] = useState(false);
  // The drag's listeners outlive the render that started it, so they read the latest.
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;
  const set = (next: number) => resizeRef.current(columnWidth(next));

  /** Ends a drag in progress; also run if the table goes away during one. */
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  // The window follows the pointer, not the 9px handle, which the pointer leaves at
  // once: pointer capture is not there for every kind of input.
  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    endDrag.current?.();
    const fromX = event.clientX;
    const from = props.current(event.currentTarget);
    const move = (e: globalThis.PointerEvent) => set(from + e.clientX - fromX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      endDrag.current = null;
      setActive(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    endDrag.current = stop;
    setActive(true);
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? COLUMN_KEY_STEP * 4 : COLUMN_KEY_STEP;
    if (event.key === "ArrowLeft")
      set(props.current(event.currentTarget) - step);
    else if (event.key === "ArrowRight")
      set(props.current(event.currentTarget) + step);
    else if (event.key === "Enter") onFit();
    else return;
    event.preventDefault();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an hr cannot be dragged or focused.
    <div
      className={styles.resize}
      role="separator"
      aria-label={`Resize ${props.header}`}
      aria-orientation="vertical"
      aria-valuenow={props.width}
      aria-valuemin={MIN_COLUMN_PX}
      aria-valuemax={MAX_COLUMN_PX}
      data-active={active}
      title="Drag to resize, double-click to fit"
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={onFit}
      onKeyDown={key}
      data-testid={props.testId}
    >
      <span className={styles.line} />
    </div>
  );
}
