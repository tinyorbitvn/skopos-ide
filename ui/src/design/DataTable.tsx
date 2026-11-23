import { type ReactNode, useMemo, useRef, useState } from "react";
import {
  ColumnResizer,
  type ColumnWidths,
  columnWidth,
  fitWidth,
  MIN_COLUMN_PX,
} from "./ColumnResizer";
import styles from "./DataTable.module.css";

export interface Column<T> {
  id: string;
  header: string;
  width?: string;
  /** "end" right-aligns the header and the cells, as for numbers. */
  align?: "start" | "end";
  sortable?: boolean;
  sortValue?(row: T): string | number;
  render(row: T): ReactNode;
}

type Sort = { id: string; dir: "asc" | "desc" };

/** Shared: `localeCompare` with options builds one of these on every call. */
const collator = new Intl.Collator(undefined, { numeric: true });

export function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

function alignClass<T>(column: Column<T>): string | undefined {
  return column.align === "end" ? styles.end : undefined;
}

export function DataTable<T>(props: {
  rows: T[];
  columns: Column<T>[];
  rowKey(row: T): string;
  rowTestId?(row: T): string;
  onRowClick?(row: T): void;
  empty?: ReactNode;
  /** The table's accessible name. */
  label?: string;
  testId?: string;
  /**
   * Widths given to columns by dragging their handles. Leave out for a table that keeps
   * its own, which last until it unmounts.
   */
  columnWidths?: ColumnWidths;
  onColumnWidthsChange?(widths: ColumnWidths): void;
}) {
  const [sort, setSort] = useState<Sort | null>(null);
  const [ownWidths, setOwnWidths] = useState<ColumnWidths>({});
  const widths = props.columnWidths ?? ownWidths;
  const tableRef = useRef<HTMLTableElement>(null);
  // The last column takes the rest of the table, so it has no handle.
  const sized = props.columns.slice(0, -1);
  const fixed = sized.some((c) => widths[c.id] !== undefined);

  /** A header cell, by column index. */
  const headerCell = (index: number) =>
    tableRef.current?.querySelectorAll("thead th")[index];

  /**
   * Gives a column its width. The first one given also fixes the others at their widths on
   * screen, so that the table, laid out at fixed widths from then on, keeps its look.
   */
  function resize(id: string, width: number): void {
    const next: Record<string, number> = { ...widths };
    sized.forEach((c, index) => {
      next[c.id] ??= columnWidth(
        headerCell(index)?.getBoundingClientRect().width ?? MIN_COLUMN_PX,
      );
    });
    next[id] = width;
    setOwnWidths(next);
    props.onColumnWidthsChange?.(next);
  }

  /**
   * The width that fits a column's header and rows: the table is laid out at max-content for
   * one measure and given back before anything paints.
   */
  function fitColumn(index: number): number {
    const table = tableRef.current;
    const col = table?.querySelectorAll("col")[index];
    if (!table) return MIN_COLUMN_PX;
    const { tableLayout, width } = table.style;
    const colWidth = col?.style.width ?? "";
    table.style.tableLayout = "auto";
    table.style.width = "max-content";
    if (col) col.style.width = "";
    const natural = headerCell(index)?.getBoundingClientRect().width ?? 0;
    table.style.tableLayout = tableLayout;
    table.style.width = width;
    if (col) col.style.width = colWidth;
    return fitWidth([natural]);
  }

  const fixedWidth = sized.reduce(
    (sum, c) => sum + (widths[c.id] ?? 0),
    MIN_COLUMN_PX,
  );

  const rows = useMemo(() => {
    const col = sort ? props.columns.find((c) => c.id === sort.id) : undefined;
    const value = col?.sortValue;
    if (!sort || !value) return props.rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...props.rows].sort((a, b) => sign * compare(value(a), value(b)));
  }, [props.rows, props.columns, sort]);

  function toggle(id: string): void {
    setSort((s) =>
      s?.id === id && s.dir === "asc"
        ? { id, dir: "desc" }
        : { id, dir: "asc" },
    );
  }

  if (props.rows.length === 0 && props.empty) {
    return <div data-testid={props.testId}>{props.empty}</div>;
  }

  return (
    <table
      ref={tableRef}
      className={styles.table}
      aria-label={props.label}
      data-testid={props.testId}
      style={
        fixed
          ? { tableLayout: "fixed", width: `max(100%, ${fixedWidth}px)` }
          : undefined
      }
    >
      {fixed ? (
        <colgroup>
          {props.columns.map((c) => (
            <col
              key={c.id}
              style={
                widths[c.id] !== undefined && c !== props.columns.at(-1)
                  ? { width: `${widths[c.id]}px` }
                  : undefined
              }
            />
          ))}
        </colgroup>
      ) : null}
      <thead>
        <tr>
          {props.columns.map((c, index) => {
            const active = sort?.id === c.id ? sort : null;
            const last = index === props.columns.length - 1;
            return (
              <th
                key={c.id}
                className={alignClass(c)}
                style={c.width && !fixed ? { width: c.width } : undefined}
                aria-sort={
                  active
                    ? active.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
              >
                {c.sortable ? (
                  <button
                    type="button"
                    className={styles.sort}
                    onClick={() => toggle(c.id)}
                  >
                    {c.header}
                    <span aria-hidden="true">
                      {active ? (active.dir === "asc" ? " ▲" : " ▼") : ""}
                    </span>
                  </button>
                ) : (
                  c.header
                )}
                {last ? null : (
                  <ColumnResizer
                    header={c.header}
                    width={widths[c.id]}
                    current={(handle) =>
                      widths[c.id] ??
                      handle.parentElement?.getBoundingClientRect().width ??
                      MIN_COLUMN_PX
                    }
                    onResize={(width) => resize(c.id, width)}
                    onFit={() => resize(c.id, fitColumn(index))}
                    testId={`column-resize-${c.id}`}
                  />
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={props.rowKey(row)}
            data-testid={props.rowTestId?.(row) ?? "row"}
            className={props.onRowClick ? styles.clickable : undefined}
            onClick={
              props.onRowClick ? () => props.onRowClick?.(row) : undefined
            }
          >
            {props.columns.map((c) => (
              <td key={c.id} className={alignClass(c)}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
