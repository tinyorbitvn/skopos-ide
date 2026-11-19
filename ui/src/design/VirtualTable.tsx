import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { compare } from "./DataTable";
import styles from "./VirtualTable.module.css";

export interface TableColumn<T> {
  id: string;
  header: string;
  /** Pixels, or any CSS grid track such as `minmax(160px, 1fr)`. */
  width: number | string;
  /**
   * A column can be sorted when it has this. Null is a row with nothing to sort by,
   * such as a cell that shows "—": it sorts last in both directions.
   */
  sortValue?(row: T): string | number | null;
  render(row: T): ReactNode;
  /** Hidden unless the table is given its own `hiddenColumns`. */
  defaultHidden?: boolean;
  /** Stays at the right edge while the table scrolls sideways. */
  stickyEnd?: boolean;
}

export type TableSort = { id: string; dir: "asc" | "desc" };

const DEFAULT_ROW_HEIGHT = 34;
const OVERSCAN = 10;
/** 12 px cell padding on each side of the 18 px checkbox, plus 2 px to spare. */
const SELECT_TRACK_PX = 44;
const CLOCK_TICK_MS = 30_000;
/** A row younger than this has its age count every second. */
const FRESH_MS = 60_000;
const FRESH_TICK_MS = 1000;
/** The narrowest and widest a column can be dragged to. */
const MIN_COLUMN_PX = 48;
const MAX_COLUMN_PX = 2000;
/** One arrow press on a column's handle moves its edge this far; with Shift, four times. */
const COLUMN_KEY_STEP = 16;

/** Widths given to columns by their handles, in pixels, by column id. */
export type ColumnWidths = Readonly<Record<string, number>>;

let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void): () => void {
  if (clockListeners.size === 0) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, CLOCK_TICK_MS);
  }
  clockListeners.add(listener);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** The time of the table a cell is in, which counts every second while it must. */
const TableNow = createContext(0);

/**
 * The current time, for cells that show an age. Every cell reads the same timer, so
 * 10,000 rows do not mean 10,000 timers, and ages move together. In a table that shows
 * a row less than a minute old, the table's own timer also counts every second.
 */
export function useNow(): number {
  const shared = useSyncExternalStore(subscribeClock, () => clockNow);
  return Math.max(shared, useContext(TableNow));
}

/**
 * Counts every second until `until`, so the age of a row just created does not stay at
 * `0s` for up to 30 s. One timer for the table; only the cells that read `useNow`
 * redraw. Its last time stays, so an age never counts backwards to the shared clock.
 */
function FreshClock(props: { until: number; children: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  const counting = now < props.until;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), FRESH_TICK_MS);
    return () => clearInterval(timer);
  }, [counting]);
  return <TableNow.Provider value={now}>{props.children}</TableNow.Provider>;
}

function track(width: number | string): string {
  return typeof width === "number" ? `${width}px` : width;
}

/** The narrowest a track can be, so the table scrolls sideways rather than crushes. */
function trackMinimum(width: number | string): number {
  if (typeof width === "number") return width;
  const px = /^(?:minmax\()?(\d+)px/.exec(width);
  return px ? Number(px[1]) : 0;
}

/**
 * The handle on a header cell's right edge: drag it, or use Left and Right (Shift for
 * bigger steps). A double-click gives the column back its own width. A drag or key press
 * starts from the width given by a handle, else the column's own width in pixels, else,
 * for a column that shares the spare room, the width its cell has on screen.
 */
function ColumnResizer(props: {
  header: string;
  width: number | undefined;
  /** The column's own width, when it is in pixels. */
  base: number | undefined;
  onResize(width: number | null): void;
  testId: string;
}) {
  const { width, base, onResize } = props;
  const drag = useRef<{ fromX: number; from: number } | null>(null);
  const [active, setActive] = useState(false);
  const set = (next: number) =>
    onResize(Math.round(Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, next))));
  const current = (handle: HTMLElement) =>
    width ??
    base ??
    handle.parentElement?.getBoundingClientRect().width ??
    MIN_COLUMN_PX;

  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { fromX: event.clientX, from: current(event.currentTarget) };
    setActive(true);
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    set(drag.current.from + event.clientX - drag.current.fromX);
  }

  function stop(): void {
    drag.current = null;
    setActive(false);
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? COLUMN_KEY_STEP * 4 : COLUMN_KEY_STEP;
    if (event.key === "ArrowLeft") set(current(event.currentTarget) - step);
    else if (event.key === "ArrowRight") set(current(event.currentTarget) + step);
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
      aria-valuenow={width}
      aria-valuemin={MIN_COLUMN_PX}
      aria-valuemax={MAX_COLUMN_PX}
      data-active={active}
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onResize(null)}
      onKeyDown={key}
      data-testid={props.testId}
    >
      <span className={styles.resizeLine} />
    </div>
  );
}

/** True for a click or key press meant for a control inside the row, or a portal. */
function belongsToControl(event: MouseEvent | KeyboardEvent): boolean {
  const target = event.target as Element;
  return (
    !event.currentTarget.contains(target) ||
    target.closest("a, button, input, select, textarea") !== null
  );
}

export function VirtualTable<T>(props: {
  rows: T[];
  columns: TableColumn<T>[];
  rowKey(row: T): string;
  /** Replaces what `defaultHidden` would hide. */
  hiddenColumns?: string[];
  /**
   * Widths given to columns by dragging their handles. Leave out for a table that keeps
   * its own, which last until it unmounts.
   */
  columnWidths?: ColumnWidths;
  onColumnWidthsChange?(widths: ColumnWidths): void;
  /** Leave out for a table that keeps its own sort. */
  sort?: TableSort | null;
  onSortChange?(s: TableSort | null): void;
  selected?: ReadonlySet<string>;
  /** Adds a column of checkboxes. */
  onSelectedChange?(s: Set<string>): void;
  onRowClick?(row: T): void;
  rowTestId?(row: T): string;
  /**
   * When a row's object was created, as RFC 3339 text. While a row shown is less than
   * a minute old, the ages in the table count every second rather than every 30 s.
   */
  rowCreated?(row: T): string | undefined;
  /** What a row's checkbox is named after: `Select <label>`. Defaults to the row key. */
  rowLabel?(row: T): string;
  /** The test id of a row's checkbox. */
  selectTestId?(row: T): string;
  activeKey?: string;
  /** Makes the sticky end cells inert, as while a drawer covers them (spec H21). */
  endInert?: boolean;
  testId?: string;
  rowHeight?: number;
}): React.JSX.Element {
  const { rowKey, onRowClick, onSelectedChange } = props;
  const rowHeight = props.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const selected = props.selected;

  const [ownSort, setOwnSort] = useState<TableSort | null>(null);
  const sort = props.sort !== undefined ? props.sort : ownSort;

  const [ownWidths, setOwnWidths] = useState<ColumnWidths>({});
  const widths = props.columnWidths ?? ownWidths;
  /** Null gives the column back the width its definition asks for. */
  function resize(id: string, width: number | null): void {
    const next = Object.fromEntries(
      Object.entries(widths).filter(([column]) => column !== id),
    );
    if (width !== null) next[id] = width;
    setOwnWidths(next);
    props.onColumnWidthsChange?.(next);
  }

  const columns = useMemo(() => {
    const hidden = props.hiddenColumns;
    return props.columns.filter((c) =>
      hidden ? !hidden.includes(c.id) : !c.defaultHidden,
    );
  }, [props.columns, props.hiddenColumns]);

  const rows = useMemo(() => {
    const value = columns.find((c) => c.id === sort?.id)?.sortValue;
    if (!sort || !value) return props.rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    // Each row's value is read once: it may mean evaluating a JSONPath.
    return props.rows
      .map((row) => ({ row, key: value(row) }))
      .sort((a, b) => {
        if (a.key === null) return b.key === null ? 0 : 1;
        if (b.key === null) return -1;
        return sign * compare(a.key, b.key);
      })
      .map(({ row }) => row);
  }, [props.rows, columns, sort]);

  function changeSort(id: string): void {
    let next: TableSort | null = { id, dir: "asc" };
    if (sort?.id === id) {
      next = sort.dir === "asc" ? { id, dir: "desc" } : null;
    }
    setOwnSort(next);
    props.onSortChange?.(next);
  }

  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });

  /** The last row whose checkbox was used, where a shift range starts. */
  const anchor = useRef<string | null>(null);

  function toggleRow(row: T, index: number, shift: boolean): void {
    const key = rowKey(row);
    const on = !selected?.has(key);
    const next = new Set(selected);
    const from =
      shift && anchor.current !== null
        ? rows.findIndex((r) => rowKey(r) === anchor.current)
        : -1;
    const [first, last] =
      from === -1
        ? [index, index]
        : [Math.min(from, index), Math.max(from, index)];
    for (let i = first; i <= last; i++) {
      if (on) next.add(rowKey(rows[i]));
      else next.delete(rowKey(rows[i]));
    }
    anchor.current = key;
    onSelectedChange?.(next);
  }

  const selectedShown = selected
    ? rows.filter((r) => selected.has(rowKey(r))).length
    : 0;
  const allShownSelected = rows.length > 0 && selectedShown === rows.length;

  function toggleAll(): void {
    const next = new Set(selected);
    for (const row of rows) {
      if (allShownSelected) next.delete(rowKey(row));
      else next.add(rowKey(row));
    }
    onSelectedChange?.(next);
  }

  const items = virtualizer.getVirtualItems();
  // Only the rows shown matter: a row out of view has no age cell to redraw.
  let freshUntil = 0;
  if (props.rowCreated) {
    for (const item of items) {
      const created = Date.parse(props.rowCreated(rows[item.index]) ?? "");
      if (created + FRESH_MS > freshUntil) freshUntil = created + FRESH_MS;
    }
  }

  const selectable = onSelectedChange !== undefined;
  const widthOf = (c: TableColumn<T>) => widths[c.id] ?? c.width;
  const tracks = columns.map((c) => track(widthOf(c)));
  const minWidth = columns.reduce(
    (sum, c) => sum + trackMinimum(widthOf(c)),
    selectable ? SELECT_TRACK_PX : 0,
  );
  const layout = {
    "--vt-columns": [
      ...(selectable ? [`${SELECT_TRACK_PX}px`] : []),
      ...tracks,
    ].join(" "),
    "--vt-min-width": `${minWidth}px`,
  } as CSSProperties;

  return (
    <div ref={scroller} className={styles.scroller} style={layout}>
      <table
        className={styles.table}
        tabIndex={-1}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: rows are selected and activated, which is what a grid is, and aria-selected needs one.
        role="grid"
        aria-rowcount={rows.length + 1}
        data-testid={props.testId}
      >
        <thead className={styles.head}>
          <tr className={styles.row} style={{ height: rowHeight }}>
            {selectable ? (
              <th className={styles.cell}>
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={allShownSelected}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate = selectedShown > 0 && !allShownSelected;
                    }
                  }}
                  onChange={toggleAll}
                />
              </th>
            ) : null}
            {columns.map((c) => {
              const active = sort?.id === c.id ? sort : null;
              return (
                <th
                  key={c.id}
                  className={
                    c.stickyEnd
                      ? `${styles.cell} ${styles.stickyEnd}`
                      : `${styles.cell} ${styles.resizable}`
                  }
                  // Named by its header alone: the handle inside it has a name of its own.
                  aria-label={c.header}
                  aria-sort={
                    active
                      ? active.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      className={styles.sort}
                      onClick={() => changeSort(c.id)}
                    >
                      {c.header}
                      <span aria-hidden="true">
                        {active ? (active.dir === "asc" ? " ▲" : " ▼") : ""}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                  {c.stickyEnd ? null : (
                    <ColumnResizer
                      header={c.header}
                      width={widths[c.id]}
                      base={typeof c.width === "number" ? c.width : undefined}
                      onResize={(width) => resize(c.id, width)}
                      testId={`column-resize-${c.id}`}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody
          className={styles.body}
          style={{ height: virtualizer.getTotalSize() }}
        >
          <FreshClock until={freshUntil}>
            {items.map((item) => {
              const row = rows[item.index];
              const key = rowKey(row);
              const isSelected = selected?.has(key) ?? false;
              return (
                <tr
                  key={key}
                  className={[
                    styles.row,
                    styles.bodyRow,
                    onRowClick ? styles.clickable : "",
                    isSelected ? styles.selected : "",
                    key === props.activeKey ? styles.active : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    height: rowHeight,
                    transform: `translateY(${item.start}px)`,
                  }}
                  aria-rowindex={item.index + 2}
                  aria-selected={isSelected}
                  aria-current={key === props.activeKey ? "true" : undefined}
                  data-testid={props.rowTestId?.(row)}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={
                    onRowClick
                      ? (e) => {
                          if (!belongsToControl(e)) onRowClick(row);
                        }
                      : undefined
                  }
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (
                            e.key === "Enter" &&
                            e.target === e.currentTarget
                          ) {
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {selectable ? (
                    <td className={styles.cell}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${props.rowLabel?.(row) ?? key}`}
                        data-testid={props.selectTestId?.(row)}
                        checked={isSelected}
                        onChange={(e) =>
                          toggleRow(
                            row,
                            item.index,
                            (e.nativeEvent as globalThis.MouseEvent).shiftKey,
                          )
                        }
                      />
                    </td>
                  ) : null}
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={
                        c.stickyEnd
                          ? `${styles.cell} ${styles.stickyEnd}`
                          : styles.cell
                      }
                      inert={props.endInert && c.stickyEnd ? true : undefined}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </FreshClock>
        </tbody>
      </table>
    </div>
  );
}
