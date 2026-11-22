import {
  columnOf,
  type FilterContext,
  type FilterIndex,
  type FilterOperator,
  type FilterParts,
  type FilterProperty,
  filterParts,
  keyCounts,
  measureHint,
  measureValue,
  NO_COLUMNS,
  type ObjectFilter,
  operatorName,
  operatorsOf,
  propertyAlone,
  propertyText,
  takesAnyValue,
  valueCounts,
} from "./filter";

/** The most keys or values one group lists (spec M15). */
export const MAX_GROUP_OPTIONS = 8;

/** What picking an option does: add a token, or replace the typed text. */
export type SuggestionPick =
  | { type: "add"; filter: ObjectFilter }
  | { type: "text"; text: string };

export interface SuggestionOption {
  /** Unique among the options shown together. */
  key: string;
  text: string;
  hint: string;
  /** Keys, operators and values show in mono. */
  mono: boolean;
  pick: SuggestionPick;
}

export interface SuggestionGroup {
  heading: string;
  options: SuggestionOption[];
}

/** What the suggestions show for the typed text (spec M15). */
export interface Suggestions {
  /** `Use: "…"` or Any value, before the groups. */
  lead: SuggestionOption[];
  /** Groups with at least one option. */
  groups: SuggestionGroup[];
  foot: string;
}

function add(
  property: FilterProperty,
  operator: FilterOperator,
  value: string,
): SuggestionPick {
  return { type: "add", filter: { property, operator, value } };
}

/** `a`, `a and b`, `a, b and c`. */
function wordList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Every option of the suggestions, in the order the keys move through them. */
export function suggestionOptions(s: Suggestions): SuggestionOption[] {
  return [...s.lead, ...s.groups.flatMap((g) => g.options)];
}

function keyOptions(
  index: FilterIndex,
  type: "label" | "annotation",
  part: string,
): SuggestionOption[] {
  const prefix = type === "label" ? "label:" : "anno:";
  return keyCounts(index, type)
    .filter((c) => c.text.toLowerCase().includes(part))
    .slice(0, MAX_GROUP_OPTIONS)
    .map((c) => ({
      key: `${prefix}${c.text}`,
      text: `${prefix}${c.text}`,
      hint: String(c.count),
      mono: true,
      pick: { type: "text", text: `${prefix}${c.text} ` },
    }));
}

/** Stage 1: a property or a key, or the text as a text filter. */
function propertyStage(
  text: string,
  index: FilterIndex,
  context: FilterContext,
): Suggestions {
  const typed = text.trim();
  const lower = typed.toLowerCase();
  const lead: SuggestionOption[] =
    typed === ""
      ? []
      : [
          {
            key: "use",
            text: `Use: "${typed}"`,
            hint: "Any column or label",
            mono: false,
            pick: add({ type: "text" }, ":", typed),
          },
        ];
  const labelOnly = lower.startsWith("label:");
  const annoOnly = lower.startsWith("anno:");
  const part = labelOnly
    ? lower.slice("label:".length)
    : annoOnly
      ? lower.slice("anno:".length)
      : lower;
  const groups: SuggestionGroup[] = [];
  if (!labelOnly && !annoOnly) {
    groups.push({
      heading: "Columns",
      options: context.columns
        .filter(
          (c) =>
            c.header.toLowerCase().includes(lower) || c.key.includes(lower),
        )
        .map((c) => ({
          key: `column:${c.key}`,
          text: c.header,
          hint: c.hidden ? "Hidden column" : "Column",
          mono: false,
          pick: { type: "text", text: `${c.key} ` },
        })),
    });
  }
  if (!annoOnly) {
    groups.push({
      heading: "Label keys",
      options: keyOptions(index, "label", part),
    });
  }
  if (!labelOnly) {
    groups.push({
      heading: "Annotation keys",
      options: keyOptions(index, "annotation", part),
    });
  }
  return {
    lead,
    groups: groups.filter((g) => g.options.length > 0),
    foot: "Pick a column or a key, or press Enter to search every column and label",
  };
}

/** Stage 2: how the property compares. */
function operatorStage(
  property: FilterProperty,
  context: FilterContext,
): Suggestions {
  const name = propertyText(property);
  return {
    lead: [],
    groups: [
      {
        heading: "Operators",
        options: operatorsOf(property, context).map((operator) => ({
          key: operator,
          text: operator,
          hint: operatorName(operator, property, context),
          mono: true,
          pick: { type: "text", text: `${name} ${operator} ` },
        })),
      },
    ],
    foot: `Choose how ${name} compares`,
  };
}

/** Stage 3: the value, from what is typed or from the list's own values. */
function valueStage(
  parts: FilterParts,
  index: FilterIndex,
  context: FilterContext,
): Suggestions {
  const { property, operator } = parts;
  const typed = parts.rest.trim();
  const name = propertyText(property);
  const allowed = operatorsOf(property, context);
  if (!allowed.includes(operator)) {
    return { lead: [], groups: [], foot: `${name} takes ${wordList(allowed)}` };
  }
  const use = (): SuggestionOption => ({
    key: "use",
    text: `Use: "${typed}"`,
    hint: `${name} ${operator}`,
    mono: false,
    pick: add(property, operator, typed),
  });
  if (operator === ">" || operator === "<") {
    const valid = measureValue(property, typed, context) !== null;
    return {
      lead: valid ? [use()] : [],
      groups: [],
      foot: valid ? "Enter adds the filter" : measureHint(property, context),
    };
  }
  const lead: SuggestionOption[] = [];
  if (typed !== "") {
    lead.push(use());
  } else if (takesAnyValue(property, operator)) {
    lead.push({
      key: "any",
      text: "Any value",
      hint: `${name} ${operator}`,
      mono: false,
      pick: add(property, operator, ""),
    });
  }
  // A time column's values change every tick and are nearly all different (spec §3.4).
  if (columnOf(property, context)?.filter.measure?.kind === "duration") {
    return {
      lead,
      groups: [],
      foot: "Type the text the column shows, such as 3d",
    };
  }
  const lower = typed.toLowerCase();
  const values = valueCounts(index, property)
    .filter((c) => c.text.toLowerCase().includes(lower))
    .slice(0, MAX_GROUP_OPTIONS)
    .map((c) => ({
      key: `value:${c.text}`,
      text: c.text === "" ? "(empty)" : c.text,
      hint: String(c.count),
      mono: c.text !== "",
      pick: add(property, operator, c.text),
    }));
  return {
    lead,
    groups:
      values.length > 0
        ? [{ heading: `Values of ${name}`, options: values }]
        : [],
    foot:
      values.length > 0
        ? "Enter adds the filter"
        : `${name} has no values in this list`,
  };
}

/** The suggestions for the typed text: a value, an operator or a property stage (spec M15). */
export function suggestionsFor(
  text: string,
  index: FilterIndex,
  context: FilterContext = NO_COLUMNS,
): Suggestions {
  const parts = filterParts(text, context);
  if (parts) return valueStage(parts, index, context);
  const property = propertyAlone(text, context);
  if (property) return operatorStage(property, context);
  return propertyStage(text, index, context);
}
