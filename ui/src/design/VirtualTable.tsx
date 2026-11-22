import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { compare } from "./DataTable";
import styles from "./VirtualTable.module.css";

/** What a filter reads from a column (column filter spec §4.1). */
export interface ColumnFilter<T> {
  /** The text the cell shows, or null when it shows "-" or nothing. */
  text(row: T, now: number): string | null;
  /** For `>` and `<`: a count, or a time in seconds. */
  measure?: {
    kind: "number" | "duration";
    amount(row: T, now: number): number | null;
  };
}

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
  /** What a filter reads from the column; a column without it cannot be filtered. */
  filter?: ColumnFilter<T>;
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
 * The shared clock while `active`, so a filter that reads ages follows them (column
 * filter spec §3.7); otherwise the time `active` last turned on, with no timer.
 */
export function useNowWhile(active: boolean): number {
  const subscribe = useCallback(
    (listener: () => void) => (active ? subscribeClock(listener) : () => {}),
    [active],
  );
  const shared = useSyncExternalStore(subscribe, () => clockNow);
  const [since, setSince] = useState(Date.now);
  useEffect(() => {
    if (active) setSince(Date.now());
  }, [active]);
  return active ? Math.max(shared, since) : since;
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
  const [active, setActive] = useState(false);
  // The drag's listeners outlive the render that started it, so they read the latest.
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;
  const set = (next: number) =>
    resizeRef.current(
      Math.round(Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, next))),
    );
  const current = (handle: HTMLElement) =>
    width ??
    base ??
    handle.parentElement?.getBoundingClientRect().width ??
    MIN_COLUMN_PX;

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
    const from = current(event.currentTarget);
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
    if (event.key === "ArrowLeft") set(current(event.currentTarget) - step);
    else if (event.key === "ArrowRight")
      set(current(event.currentTarget) + step);
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

interface BodyRowProps<T> {
  row: T;
  index: number;
  /** Where the virtualizer puts the row, in pixels from the top of the body. */
  start: number;
  height: number;
  columns: TableColumn<T>[];
  selectable: boolean;
  isSelected: boolean;
  isActive: boolean;
  clickable: boolean;
  endInert: boolean;
  testId: string | undefined;
  label: string;
  selectTestId: string | undefined;
  /** Stable for the table's life, so a row with nothing new does not render again. */
  onActivate(row: T): void;
  onToggle(row: T, index: number, shift: boolean): void;
}

function BodyRowView<T>(props: BodyRowProps<T>): React.JSX.Element {
  const { row, index, columns, onActivate } = props;
  return (
    <tr
      className={[
        styles.row,
        styles.bodyRow,
        props.clickable ? styles.clickable : "",
        props.isSelected ? styles.selected : "",
        props.isActive ? styles.active : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        height: props.height,
        transform: `translateY(${props.start}px)`,
      }}
      aria-rowindex={index + 2}
      aria-selected={props.isSelected}
      aria-current={props.isActive ? "true" : undefined}
      data-testid={props.testId}
      tabIndex={props.clickable ? 0 : undefined}
      onClick={
        props.clickable
          ? (e) => {
              if (!belongsToControl(e)) onActivate(row);
            }
          : undefined
      }
      onKeyDown={
        props.clickable
          ? (e) => {
              if (e.key === "Enter" && e.target === e.currentTarget) {
                onActivate(row);
              }
            }
          : undefined
      }
    >
      {props.selectable ? (
        <td className={styles.cell}>
          <input
            type="checkbox"
            aria-label={`Select ${props.label}`}
            data-testid={props.selectTestId}
            checked={props.isSelected}
            onChange={(e) =>
              props.onToggle(
                row,
                index,
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
            c.stickyEnd ? `${styles.cell} ${styles.stickyEnd}` : styles.cell
          }
          inert={props.endInert && c.stickyEnd ? true : undefined}
        >
          {c.render(row)}
        </td>
      ))}
    </tr>
  );
}

/**
 * One body row. A watch batch renders the table again; a row whose object, columns,
 * selection and place are as they were keeps what it rendered.
 */
const BodyRow = memo(BodyRowView) as typeof BodyRowView;

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

  // Keyed on what the order depends on, so a render that changes none of it, such as a
  // selection or a new hidden list, does not sort again.
  const sortBy = sort
    ? columns.find((c) => c.id === sort.id)?.sortValue
    : undefined;
  const sortDir = sort?.dir;
  const rows = useMemo(() => {
    if (!sortBy || !sortDir) return props.rows;
    const sign = sortDir === "asc" ? 1 : -1;
    // Each row's value is read once: it may mean evaluating a JSONPath.
    return props.rows
      .map((row) => ({ row, key: sortBy(row) }))
      .sort((a, b) => {
        if (a.key === null) return b.key === null ? 0 : 1;
        if (b.key === null) return -1;
        return sign * compare(a.key, b.key);
      })
      .map(({ row }) => row);
  }, [props.rows, sortBy, sortDir]);

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

  // The rows are memoised, so they are given handlers that stay the same and call the
  // ones of the latest render: the caller's onRowClick, and toggleRow over the rows shown.
  const handlers = useRef({ onRowClick, toggleRow });
  handlers.current = { onRowClick, toggleRow };
  const activate = useCallback(
    (row: T) => handlers.current.onRowClick?.(row),
    [],
  );
  const toggle = useCallback(
    (row: T, index: number, shift: boolean) =>
      handlers.current.toggleRow(row, index, shift),
    [],
  );

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
              return (
                <BodyRow
                  key={key}
                  row={row}
                  index={item.index}
                  start={item.start}
                  height={rowHeight}
                  columns={columns}
                  selectable={selectable}
                  isSelected={selected?.has(key) ?? false}
                  isActive={key === props.activeKey}
                  clickable={onRowClick !== undefined}
                  endInert={props.endInert ?? false}
                  testId={props.rowTestId?.(row)}
                  label={props.rowLabel?.(row) ?? key}
                  selectTestId={props.selectTestId?.(row)}
                  onActivate={activate}
                  onToggle={toggle}
                />
              );
            })}
          </FreshClock>
        </tbody>
      </table>
    </div>
  );
}
