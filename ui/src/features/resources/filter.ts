import type { KubeObject } from "../../kinds/objects";

/** What a filter compares (spec M8). A text filter searches names, namespaces and labels. */
export type FilterProperty =
  | { type: "text" }
  | { type: "name" }
  | { type: "namespace" }
  | { type: "label"; key: string }
  | { type: "annotation"; key: string };

export type FilterOperator = "=" | "!=" | ":" | "!:";

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
  ];

/** The operators a property takes: a text filter takes only `:` and `!:` (spec M8). */
export function operatorsOf(
  property: FilterProperty,
): readonly FilterOperator[] {
  return property.type === "text" ? [":", "!:"] : ["=", "!=", ":", "!:"];
}

/** The text form of a property: `name`, `namespace`, `label:‹key›`, `anno:‹key›`; "" for text. */
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
  }
}

/** The property in words, as the edit panel shows it (spec M19). */
export function propertyWords(property: FilterProperty): string {
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

/** Whether an empty value means "any value": a label or annotation with `:` or `!:`. */
export function takesAnyValue(
  property: FilterProperty,
  operator: FilterOperator,
): boolean {
  return (
    (property.type === "label" || property.type === "annotation") &&
    (operator === ":" || operator === "!:")
  );
}

/** A key: one or more characters other than white space, `=`, `!` and `:` (spec M9). */
const KEY = "[^\\s=!:]+";
const PROPERTY = `(?:(namespace|name)|(label|anno):(${KEY}))`;
/** A property, then an operator, longest first, then the rest (spec M9, step 2). */
const WITH_OPERATOR = new RegExp(`^\\s*${PROPERTY}\\s*(!=|!:|=|:)(.*)$`, "i");
/** A property followed by white space and nothing else (spec M9, step 3). */
const PROPERTY_ALONE = new RegExp(`^\\s*${PROPERTY}\\s+$`, "i");
const KEYED_START = /^\s*(?:label|anno):/i;

function propertyFrom(match: RegExpExecArray): FilterProperty {
  const [, word, prefix, key] = match;
  if (word !== undefined) {
    return word.toLowerCase() === "name"
      ? { type: "name" }
      : { type: "namespace" };
  }
  return prefix.toLowerCase() === "label"
    ? { type: "label", key }
    : { type: "annotation", key };
}

/** Typed text that holds a property and an operator: both, and the rest as typed. */
export interface FilterParts {
  property: FilterProperty;
  operator: FilterOperator;
  rest: string;
}

/** Splits typed text into a property, an operator and the rest (spec M9, step 2), or null. */
export function filterParts(text: string): FilterParts | null {
  const match = WITH_OPERATOR.exec(text);
  if (!match) return null;
  return {
    property: propertyFrom(match),
    operator: match[4] as FilterOperator,
    rest: match[5],
  };
}

/** The property of text that is a property and white space only (spec M9, step 3), or null. */
export function propertyAlone(text: string): FilterProperty | null {
  const match = PROPERTY_ALONE.exec(text);
  return match ? propertyFrom(match) : null;
}

/**
 * Reads typed text (spec M9): nothing gives null; a property, an operator and a value give
 * that filter, with an empty value allowed for `:` and `!:` only; a property alone, or a
 * `label:` or `anno:` start without an operator, is "incomplete"; any other text is a text
 * filter with `:`. The property is read ignoring case; the key and the value keep theirs.
 */
export function parseFilter(text: string): ObjectFilter | "incomplete" | null {
  if (text.trim() === "") return null;
  const parts = filterParts(text);
  if (parts) {
    const value = parts.rest.trim();
    if (value === "" && (parts.operator === "=" || parts.operator === "!=")) {
      return "incomplete";
    }
    return { property: parts.property, operator: parts.operator, value };
  }
  if (propertyAlone(text) !== null || KEYED_START.test(text)) {
    return "incomplete";
  }
  return { property: { type: "text" }, operator: ":", value: text.trim() };
}

/** The filter the box's text applies while it is typed (spec M13), or null. */
export function typedFilter(text: string): ObjectFilter | null {
  const parsed = parseFilter(text);
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

/** One word of a text filter: a `k=v` label, or part of the name, namespace or a label. */
function wordMatches(o: KubeObject, word: string): boolean {
  if (word.includes("=")) return labelsForWord(o, word).length > 0;
  return (
    o.metadata.name.toLowerCase().includes(word) ||
    (o.metadata.namespace ?? "").toLowerCase().includes(word) ||
    labelsForWord(o, word).length > 0
  );
}

/** The filter's own test, before `!=` and `!:` turn it around. */
function holds(o: KubeObject, filter: ObjectFilter): boolean {
  const { property } = filter;
  const value = filter.value.toLowerCase();
  const exact = filter.operator === "=" || filter.operator === "!=";
  switch (property.type) {
    case "text":
      return words(filter.value).every((word) => wordMatches(o, word));
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
  }
}

/** Whether the object meets one filter, ignoring case (spec M10, M11). */
export function matchesFilter(o: KubeObject, filter: ObjectFilter): boolean {
  const negated = filter.operator === "!=" || filter.operator === "!:";
  return holds(o, filter) !== negated;
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
): boolean {
  const byTokens =
    tokens.length === 0 ||
    (join === "and"
      ? tokens.every((t) => matchesFilter(o, t))
      : tokens.some((t) => matchesFilter(o, t)));
  return byTokens && (typed === null || matchesFilter(o, typed));
}

/** A label or annotation through which a filter matched a row (spec M20). */
export interface MatchChip {
  kind: "label" | "anno";
  key: string;
  value: string;
}

/** `‹key›=‹value›`, the part of a chip after its kind. */
export function chipText(chip: MatchChip): string {
  return `${chip.key}=${chip.value}`;
}

/**
 * The labels and annotations through which these filters match the object positively, each
 * once: `=` and `:` on a label or annotation, and a text word that matched a label. `!=`,
 * `!:`, names and namespaces add none (spec M20).
 */
export function matchChips(
  o: KubeObject,
  filters: readonly ObjectFilter[],
): MatchChip[] {
  const chips = new Map<string, MatchChip>();
  const add = (kind: MatchChip["kind"], key: string, value: string) =>
    chips.set(`${kind}\n${key}\n${value}`, { kind, key, value });
  for (const filter of filters) {
    if (filter.operator === "!=" || filter.operator === "!:") continue;
    if (!matchesFilter(o, filter)) continue;
    const { property } = filter;
    if (property.type === "text") {
      for (const word of words(filter.value)) {
        for (const [k, v] of labelsForWord(o, word)) add("label", k, v);
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
    }
  }
  return [...chips.values()];
}

/** A key or value of the listed objects with the number of objects that carry it. */
export interface Count {
  text: string;
  count: number;
}

/** Keys, values and their counts of one list of objects (spec M15, M17). */
export interface FilterIndex {
  names: Map<string, number>;
  namespaces: Map<string, number>;
  /** key → value → objects. A key's objects are the sum of its values'. */
  labels: Map<string, Map<string, number>>;
  annotations: Map<string, Map<string, number>>;
}

function bump(map: Map<string, number>, text: string): void {
  map.set(text, (map.get(text) ?? 0) + 1);
}

/** Counts every name, namespace, label and annotation of the objects once. */
export function buildFilterIndex(objects: readonly KubeObject[]): FilterIndex {
  const index: FilterIndex = {
    names: new Map(),
    namespaces: new Map(),
    labels: new Map(),
    annotations: new Map(),
  };
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
