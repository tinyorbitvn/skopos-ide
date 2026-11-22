import type { KubeObject } from "../../kinds/objects";
import {
  type CellValue,
  type FilterColumn,
  measureLimit,
  OWN_KEYS,
  type RowValues,
  rowValues,
} from "./columnFilter";

/** What a filter compares (spec M8, column filter spec §3.2). A text filter searches every column too. */
export type FilterProperty =
  | { type: "text" }
  | { type: "name" }
  | { type: "namespace" }
  | { type: "label"; key: string }
  | { type: "annotation"; key: string }
  | { type: "column"; key: string };

export type FilterOperator = "=" | "!=" | ":" | "!:" | ">" | "<";

export interface ObjectFilter {
  property: FilterProperty;
  operator: FilterOperator;
  value: string;
}

/** How the tokens combine (spec M12). */
export type FilterJoin = "and" | "or";

/** Never matched and never suggested (spec M11); the core strips it from rows as well. */
export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** The operators in the order the suggestions list them, with their names (spec M15). */
export const OPERATORS: readonly { operator: FilterOperator; name: string }[] =
  [
    { operator: "=", name: "Equals" },
    { operator: "!=", name: "Does not equal" },
    { operator: ":", name: "Contains" },
    { operator: "!:", name: "Does not contain" },
    { operator: ">", name: "Greater than" },
    { operator: "<", name: "Less than" },
  ];

/** The list's columns and the time a filter reads them at (column filter spec §4.3). */
export interface FilterContext {
  columns: readonly FilterColumn[];
  now: number;
  values: RowValues;
  byKey: ReadonlyMap<string, FilterColumn>;
  /** A property, an operator, longest first, then the rest (spec M9, step 2). */
  withOperator: RegExp;
  /** A property followed by white space and nothing else (spec M9, step 3). */
  propertyAlone: RegExp;
}

/** A key: one or more characters other than white space, `=`, `!`, `:`, `<` and `>` (spec M9). */
const KEY = "[^\\s=!:<>]+";
const OPERATOR = "(!=|!:|=|:|>|<)";
const KEYED_START = /^\s*(?:label|anno):/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Patterns {
  withOperator: RegExp;
  propertyAlone: RegExp;
}

/** The patterns of one list of columns, built once for it. */
const patternCache = new WeakMap<readonly FilterColumn[], Patterns>();

function patternsOf(columns: readonly FilterColumn[]): Patterns {
  const cached = patternCache.get(columns);
  if (cached) return cached;
  // Longest first, so `ip-family` is tried before `ip` (column filter spec §3.2). With no
  // column, `(?!)` keeps the group, which never matches, so the groups keep their numbers.
  const keys = columns
    .map((c) => c.key)
    .filter((key) => !OWN_KEYS.has(key))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const columnGroup = keys.length > 0 ? keys.join("|") : "(?!)";
  const property = `(?:(label|anno):(${KEY})|(namespace|name)|(${columnGroup}))`;
  const patterns = {
    withOperator: new RegExp(`^\\s*${property}\\s*${OPERATOR}(.*)$`, "i"),
    propertyAlone: new RegExp(`^\\s*${property}\\s+$`, "i"),
  };
  patternCache.set(columns, patterns);
  return patterns;
}

/** The filter context of a list's columns at `now`. */
export function filterContext(
  columns: readonly FilterColumn[],
  now: number,
): FilterContext {
  return {
    columns,
    now,
    values: rowValues(columns, now),
    byKey: new Map(columns.map((c) => [c.key, c])),
    ...patternsOf(columns),
  };
}

/** No columns: names, namespaces, labels and annotations alone, as before columns. */
export const NO_COLUMNS: FilterContext = filterContext([], 0);

/** The column a property names in the list, if any. */
export function columnOf(
  property: FilterProperty,
  context: FilterContext = NO_COLUMNS,
): FilterColumn | undefined {
  return property.type === "column"
    ? context.byKey.get(property.key)
    : undefined;
}

const TEXT_OPERATORS: readonly FilterOperator[] = [":", "!:"];
const COMPARE_OPERATORS: readonly FilterOperator[] = ["=", "!=", ":", "!:"];
const MEASURE_OPERATORS: readonly FilterOperator[] = [
  ...COMPARE_OPERATORS,
  ">",
  "<",
];

/** The operators a property takes (spec M8, column filter spec §3.2). */
export function operatorsOf(
  property: FilterProperty,
  context: FilterContext = NO_COLUMNS,
): readonly FilterOperator[] {
  if (property.type === "text") return TEXT_OPERATORS;
  return columnOf(property, context)?.filter.measure
    ? MEASURE_OPERATORS
    : COMPARE_OPERATORS;
}

/** An operator's name for a property: a time column's `>` and `<` are Longer and Shorter than. */
export function operatorName(
  operator: FilterOperator,
  property: FilterProperty,
  context: FilterContext = NO_COLUMNS,
): string {
  if (columnOf(property, context)?.filter.measure?.kind === "duration") {
    if (operator === ">") return "Longer than";
    if (operator === "<") return "Shorter than";
  }
  return OPERATORS.find((o) => o.operator === operator)?.name ?? operator;
}

/** The limit a `>` or `<` value gives on the property's column, or null. */
export function measureValue(
  property: FilterProperty,
  value: string,
  context: FilterContext = NO_COLUMNS,
): number | null {
  const measure = columnOf(property, context)?.filter.measure;
  return measure ? measureLimit(measure.kind, value) : null;
}

/** What to type after `>` or `<` on the property's column (column filter spec §3.4). */
export function measureHint(
  property: FilterProperty,
  context: FilterContext = NO_COLUMNS,
): string {
  return columnOf(property, context)?.filter.measure?.kind === "duration"
    ? "Type a time such as 30m, 2h or 7d"
    : "Type a number";
}

/** The text form of a property: `name`, `namespace`, `label:‹key›`, `anno:‹key›`, the column's key; "" for text. */
export function propertyText(property: FilterProperty): string {
  switch (property.type) {
    case "text":
      return "";
    case "name":
      return "name";
    case "namespace":
      return "namespace";
    case "label":
      return `label:${property.key}`;
    case "annotation":
      return `anno:${property.key}`;
    case "column":
      return property.key;
  }
}

/** The property in words, as the edit panel shows it (spec M19). */
export function propertyWords(
  property: FilterProperty,
  context: FilterContext = NO_COLUMNS,
): string {
  switch (property.type) {
    case "text":
      return "Free text";
    case "name":
      return "Name";
    case "namespace":
      return "Namespace";
    case "label":
      return `Label ${property.key}`;
    case "annotation":
      return `Annotation ${property.key}`;
    case "column":
      return columnOf(property, context)?.header ?? property.key;
  }
}

/**
 * The text form of a filter (spec M8): `‹property› ‹operator› ‹value›`, or `"‹value›"`
 * and `not "‹value›"` for a text filter.
 */
export function filterText(filter: ObjectFilter): string {
  if (filter.property.type === "text") {
    const quoted = `"${filter.value}"`;
    return filter.operator === "!:" ? `not ${quoted}` : quoted;
  }
  const head = `${propertyText(filter.property)} ${filter.operator}`;
  return filter.value === "" ? head : `${head} ${filter.value}`;
}

/** Whether an empty value means "any value": a label, annotation or column with `:` or `!:`. */
export function takesAnyValue(
  property: FilterProperty,
  operator: FilterOperator,
): boolean {
  return (
    (property.type === "label" ||
      property.type === "annotation" ||
      property.type === "column") &&
    (operator === ":" || operator === "!:")
  );
}

function propertyFrom(match: RegExpExecArray): FilterProperty {
  const [, prefix, key, word, column] = match;
  if (prefix !== undefined) {
    return prefix.toLowerCase() === "label"
      ? { type: "label", key }
      : { type: "annotation", key };
  }
  if (word !== undefined) {
    return word.toLowerCase() === "name"
      ? { type: "name" }
      : { type: "namespace" };
  }
  return { type: "column", key: column.toLowerCase() };
}

/** Typed text that holds a property and an operator: both, and the rest as typed. */
export interface FilterParts {
  property: FilterProperty;
  operator: FilterOperator;
  rest: string;
}

/** Splits typed text into a property, an operator and the rest (spec M9, step 2), or null. */
export function filterParts(
  text: string,
  context: FilterContext = NO_COLUMNS,
): FilterParts | null {
  const match = context.withOperator.exec(text);
  if (!match) return null;
  return {
    property: propertyFrom(match),
    operator: match[5] as FilterOperator,
    rest: match[6],
  };
}

/** The property of text that is a property and white space only (spec M9, step 3), or null. */
export function propertyAlone(
  text: string,
  context: FilterContext = NO_COLUMNS,
): FilterProperty | null {
  const match = context.propertyAlone.exec(text);
  return match ? propertyFrom(match) : null;
}

/**
 * Reads typed text (spec M9, column filter spec §3.2): nothing gives null; a property, an
 * operator it takes and a value give that filter, with an empty value allowed for `:` and
 * `!:` only, and `>` and `<` needing a number or a time; a property alone, an operator the
 * property does not take, or a `label:` or `anno:` start without an operator, is
 * "incomplete"; any other text is a text filter with `:`. The property is read ignoring
 * case; the key and the value keep theirs.
 */
export function parseFilter(
  text: string,
  context: FilterContext = NO_COLUMNS,
): ObjectFilter | "incomplete" | null {
  if (text.trim() === "") return null;
  const parts = filterParts(text, context);
  if (parts) {
    const { property, operator } = parts;
    const value = parts.rest.trim();
    if (!operatorsOf(property, context).includes(operator)) return "incomplete";
    if (operator === ">" || operator === "<") {
      return measureValue(property, value, context) === null
        ? "incomplete"
        : { property, operator, value };
    }
    if (value === "" && (operator === "=" || operator === "!=")) {
      return "incomplete";
    }
    return { property, operator, value };
  }
  if (propertyAlone(text, context) !== null || KEYED_START.test(text)) {
    return "incomplete";
  }
  return { property: { type: "text" }, operator: ":", value: text.trim() };
}

/** The filter the box's text applies while it is typed (spec M13), or null. */
export function typedFilter(
  text: string,
  context: FilterContext = NO_COLUMNS,
): ObjectFilter | null {
  const parsed = parseFilter(text, context);
  return parsed === null || parsed === "incomplete" ? null : parsed;
}

/** The object's labels or annotations as [key, value]; never the last-applied annotation. */
function keyed(
  o: KubeObject,
  type: "label" | "annotation",
): [string, string][] {
  const source = type === "label" ? o.metadata.labels : o.metadata.annotations;
  return Object.entries(source ?? {}).filter(
    ([key, value]) =>
      typeof value === "string" &&
      (type === "label" || key.toLowerCase() !== LAST_APPLIED),
  );
}

/** The labels a word of a text filter matches: `k=v` exactly, else by key or value. */
function labelsForWord(o: KubeObject, word: string): [string, string][] {
  const labels = keyed(o, "label");
  const equals = word.indexOf("=");
  if (equals !== -1) {
    const key = word.slice(0, equals);
    const value = word.slice(equals + 1);
    return labels.filter(
      ([k, v]) => k.toLowerCase() === key && v.toLowerCase() === value,
    );
  }
  return labels.filter(
    ([k, v]) =>
      k.toLowerCase().includes(word) || v.toLowerCase().includes(word),
  );
}

/** The lower-case words of a text filter's value. */
function words(value: string): string[] {
  return value.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The columns, hidden or shown, whose text holds a word of a text filter, in table order. */
function columnsForWord(
  o: KubeObject,
  word: string,
  context: FilterContext,
): [FilterColumn, CellValue][] {
  if (context.columns.length === 0) return [];
  const cells = context.values.cells(o);
  const hits: [FilterColumn, CellValue][] = [];
  for (const column of context.columns) {
    const cell = cells.get(column.key);
    if (cell?.lower?.includes(word)) hits.push([column, cell]);
  }
  return hits;
}

/** One word of a text filter: a `k=v` label, or part of the name, namespace, a label or a column. */
function wordMatches(
  o: KubeObject,
  word: string,
  context: FilterContext,
): boolean {
  if (word.includes("=")) return labelsForWord(o, word).length > 0;
  return (
    o.metadata.name.toLowerCase().includes(word) ||
    (o.metadata.namespace ?? "").toLowerCase().includes(word) ||
    labelsForWord(o, word).length > 0 ||
    columnsForWord(o, word, context).length > 0
  );
}

/** The filter's own test, before `!=` and `!:` turn it around. */
function holds(
  o: KubeObject,
  filter: ObjectFilter,
  context: FilterContext,
): boolean {
  const { property } = filter;
  const value = filter.value.toLowerCase();
  const exact = filter.operator === "=" || filter.operator === "!=";
  switch (property.type) {
    case "text":
      return words(filter.value).every((word) => wordMatches(o, word, context));
    case "name":
    case "namespace": {
      const own = (
        property.type === "name"
          ? o.metadata.name
          : (o.metadata.namespace ?? "")
      ).toLowerCase();
      return exact ? own === value : own.includes(value);
    }
    case "label":
    case "annotation": {
      const key = property.key.toLowerCase();
      return keyed(o, property.type).some(([k, v]) => {
        if (k.toLowerCase() !== key) return false;
        const own = v.toLowerCase();
        return exact ? own === value : own.includes(value);
      });
    }
    case "column": {
      const cell = context.values.cells(o).get(property.key);
      if (cell === undefined) return false;
      if (filter.operator === ">" || filter.operator === "<") {
        const limit = measureValue(property, filter.value, context);
        if (cell.amount === null || limit === null) return false;
        return filter.operator === ">"
          ? cell.amount > limit
          : cell.amount < limit;
      }
      if (value === "") return cell.lower !== null;
      if (cell.lower === null) return false;
      return exact ? cell.lower === value : cell.lower.includes(value);
    }
  }
}

/** Whether the object meets one filter, ignoring case (spec M10, M11, column filter spec §3.3). */
export function matchesFilter(
  o: KubeObject,
  filter: ObjectFilter,
  context: FilterContext = NO_COLUMNS,
): boolean {
  // A token whose column left the list matches no row (column filter spec §3.5).
  if (
    filter.property.type === "column" &&
    !context.byKey.has(filter.property.key)
  ) {
    return false;
  }
  const negated = filter.operator === "!=" || filter.operator === "!:";
  return holds(o, filter, context) !== negated;
}

/**
 * Whether the object passes (spec M12, M13): every token for "and", any token for "or",
 * none means all; then the typed filter, which always narrows.
 */
export function passes(
  o: KubeObject,
  tokens: readonly ObjectFilter[],
  join: FilterJoin,
  typed: ObjectFilter | null,
  context: FilterContext = NO_COLUMNS,
): boolean {
  const byTokens =
    tokens.length === 0 ||
    (join === "and"
      ? tokens.every((t) => matchesFilter(o, t, context))
      : tokens.some((t) => matchesFilter(o, t, context)));
  return byTokens && (typed === null || matchesFilter(o, typed, context));
}

/** A label, an annotation or a hidden column through which a filter matched a row (spec M20, column filter spec §3.6). */
export interface MatchChip {
  kind: "label" | "anno" | "column";
  key: string;
  value: string;
}

/** `‹key›=‹value›`, the part of a chip after its kind. */
export function chipText(chip: MatchChip): string {
  return `${chip.key}=${chip.value}`;
}

/**
 * The labels, annotations and hidden columns through which these filters match the object
 * positively, each once: `=` and `:` on a label or annotation, a text word that matched a
 * label, and a match through a hidden column (column filter spec §3.6). `!=` and `!:` add
 * none; neither does a shown column, nor a name or namespace while its column is shown.
 */
export function matchChips(
  o: KubeObject,
  filters: readonly ObjectFilter[],
  context: FilterContext = NO_COLUMNS,
): MatchChip[] {
  const chips = new Map<string, MatchChip>();
  const add = (kind: MatchChip["kind"], key: string, value: string) =>
    chips.set(`${kind}\n${key}\n${value}`, { kind, key, value });
  for (const filter of filters) {
    if (filter.operator === "!=" || filter.operator === "!:") continue;
    if (!matchesFilter(o, filter, context)) continue;
    const { property } = filter;
    if (property.type === "text") {
      for (const word of words(filter.value)) {
        for (const [k, v] of labelsForWord(o, word)) add("label", k, v);
        if (word.includes("=")) continue;
        for (const [column, cell] of columnsForWord(o, word, context)) {
          if (column.hidden && cell.text !== null) {
            add("column", column.key, cell.text);
          }
        }
      }
    } else if (property.type === "label" || property.type === "annotation") {
      const key = property.key.toLowerCase();
      const value = filter.value.toLowerCase();
      for (const [k, v] of keyed(o, property.type)) {
        const own = v.toLowerCase();
        const hit =
          k.toLowerCase() === key &&
          (filter.operator === "=" ? own === value : own.includes(value));
        if (hit) add(property.type === "label" ? "label" : "anno", k, v);
      }
    } else {
      // A name, a namespace or a column: a chip while its column is hidden.
      const key = property.type === "column" ? property.key : property.type;
      if (context.byKey.get(key)?.hidden) {
        const cell = context.values.cells(o).get(key);
        if (cell !== undefined && cell.text !== null) {
          add("column", key, cell.text);
        }
      }
    }
  }
  return [...chips.values()];
}

/** A key or value of the listed objects with the number of objects that carry it. */
export interface Count {
  text: string;
  count: number;
}

/** Keys, values and their counts of one list of objects (spec M15, M17, column filter spec §4.4). */
export interface FilterIndex {
  names: Map<string, number>;
  namespaces: Map<string, number>;
  /** key → value → objects. A key's objects are the sum of its values'. */
  labels: Map<string, Map<string, number>>;
  annotations: Map<string, Map<string, number>>;
  /** A column's key → its texts → objects; not for name, namespace or time columns. */
  columns: Map<string, Map<string, number>>;
}

function bump(map: Map<string, number>, text: string): void {
  map.set(text, (map.get(text) ?? 0) + 1);
}

/** Counts every name, namespace, label, annotation and column text of the objects once. */
export function buildFilterIndex(
  objects: readonly KubeObject[],
  context: FilterContext = NO_COLUMNS,
): FilterIndex {
  const index: FilterIndex = {
    names: new Map(),
    namespaces: new Map(),
    labels: new Map(),
    annotations: new Map(),
    columns: new Map(),
  };
  // A time column's texts change as the clock moves, so they are not suggested (spec §3.4).
  const counted = context.columns
    .filter(
      (c) => !OWN_KEYS.has(c.key) && c.filter.measure?.kind !== "duration",
    )
    .map((c) => {
      const counts = new Map<string, number>();
      index.columns.set(c.key, counts);
      return [c.key, counts] as const;
    });
  for (const o of objects) {
    bump(index.names, o.metadata.name);
    bump(index.namespaces, o.metadata.namespace ?? "");
    for (const type of ["label", "annotation"] as const) {
      const byKey = type === "label" ? index.labels : index.annotations;
      for (const [key, value] of keyed(o, type)) {
        const values = byKey.get(key) ?? new Map<string, number>();
        bump(values, value);
        byKey.set(key, values);
      }
    }
    if (counted.length > 0) {
      const cells = context.values.cells(o);
      for (const [key, counts] of counted) {
        const text = cells.get(key)?.text;
        if (text !== undefined && text !== null) bump(counts, text);
      }
    }
  }
  return index;
}

/** Most common first, then by text. */
function sorted(map: Map<string, number>): Count[] {
  return [...map]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

/** The label or annotation keys with the number of objects that carry each. */
export function keyCounts(
  index: FilterIndex,
  type: "label" | "annotation",
): Count[] {
  const byKey = type === "label" ? index.labels : index.annotations;
  const keys = new Map<string, number>();
  for (const [key, values] of byKey) {
    let total = 0;
    for (const n of values.values()) total += n;
    keys.set(key, total);
  }
  return sorted(keys);
}

/** A property's values among the objects with their counts; a key is matched ignoring case. */
export function valueCounts(
  index: FilterIndex,
  property: FilterProperty,
): Count[] {
  switch (property.type) {
    case "text":
      return [];
    case "name":
      return sorted(index.names);
    case "namespace":
      return sorted(index.namespaces);
    case "column":
      return sorted(index.columns.get(property.key) ?? new Map());
    case "label":
    case "annotation": {
      const byKey =
        property.type === "label" ? index.labels : index.annotations;
      const key = property.key.toLowerCase();
      const values = new Map<string, number>();
      for (const [k, counts] of byKey) {
        if (k.toLowerCase() !== key) continue;
        for (const [value, n] of counts) {
          values.set(value, (values.get(value) ?? 0) + n);
        }
      }
      return sorted(values);
    }
  }
}
