import type { ColumnFilter, TableColumn } from "../../design/VirtualTable";
import type { KubeObject } from "../../kinds/objects";

/** A column a filter can read: its key, its header, and whether it is hidden (column filter spec §3.1). */
export interface FilterColumn {
  key: string;
  header: string;
  hidden: boolean;
  filter: ColumnFilter<KubeObject>;
}

/** The default columns that stand for the object's own name and namespace. */
export const OWN_KEYS: ReadonlySet<string> = new Set(["name", "namespace"]);

/** The words of labels and annotations, which a column's key never takes. */
const RESERVED: Readonly<Record<string, string>> = {
  label: "label-column",
  anno: "anno-column",
};

/** A header as a key (spec §3.1): lower case, white space as one `-`, without `=`, `!`, `:`, `<`, `>`. */
export function headerKey(header: string): string {
  const key = header
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[=!:<>]/g, "");
  if (key === "") return "column";
  return RESERVED[key] ?? key;
}

/** The list's filter columns in table order, each with a unique key; columns without a filter are left out. */
export function filterColumns(
  columns: readonly TableColumn<KubeObject>[],
  hiddenIds: readonly string[],
): FilterColumn[] {
  const hidden = new Set(hiddenIds);
  const taken = new Set<string>();
  const result: FilterColumn[] = [];
  for (const column of columns) {
    if (!column.filter) continue;
    let key = column.id;
    if (!OWN_KEYS.has(column.id)) {
      const base = headerKey(column.header);
      key = base;
      for (let n = 2; taken.has(key) || OWN_KEYS.has(key); n++) {
        key = `${base}-${n}`;
      }
    }
    taken.add(key);
    result.push({
      key,
      header: column.header,
      hidden: hidden.has(column.id),
      filter: column.filter,
    });
  }
  return result;
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** A number for `>` or `<` (spec §5.1), or null. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  return NUMBER.test(trimmed) ? Number(trimmed) : null;
}

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  y: 365 * 86_400,
};
const DURATION = /^(?:\d+[smhdy])+$/i;
const DURATION_PART = /(\d+)([smhdy])/gi;

/** A time for `>` or `<` (spec §5.2), in seconds, or null. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!DURATION.test(trimmed)) return null;
  let seconds = 0;
  for (const [, count, unit] of trimmed.matchAll(DURATION_PART)) {
    seconds += Number(count) * UNIT_SECONDS[unit.toLowerCase()];
  }
  return seconds;
}

/** The limit of `>` or `<` for a measure, or null when the text is not one. */
export function measureLimit(
  kind: "number" | "duration",
  text: string,
): number | null {
  return kind === "number" ? parseNumber(text) : parseDuration(text);
}

/** One cell as a filter reads it: the text it shows, that text in lower case, and its amount. */
export interface CellValue {
  text: string | null;
  lower: string | null;
  amount: number | null;
}

/** Each row's cells by key, worked out once for one list of columns and one time (spec §6). */
export interface RowValues {
  cells(row: KubeObject): ReadonlyMap<string, CellValue>;
}

export function rowValues(
  columns: readonly FilterColumn[],
  now: number,
): RowValues {
  const rows = new WeakMap<KubeObject, Map<string, CellValue>>();
  return {
    cells(row) {
      let cells = rows.get(row);
      if (cells === undefined) {
        cells = new Map();
        for (const column of columns) {
          const text = column.filter.text(row, now);
          cells.set(column.key, {
            text,
            lower: text === null ? null : text.toLowerCase(),
            amount: column.filter.measure?.amount(row, now) ?? null,
          });
        }
        rows.set(row, cells);
      }
      return cells;
    },
  };
}
