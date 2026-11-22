import {
  type FilterIndex,
  type FilterOperator,
  type FilterParts,
  type FilterProperty,
  filterParts,
  keyCounts,
  type ObjectFilter,
  OPERATORS,
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

const PROPERTIES = [
  { id: "name", name: "Name" },
  { id: "namespace", name: "Namespace" },
] as const;

function add(
  property: FilterProperty,
  operator: FilterOperator,
  value: string,
): SuggestionPick {
  return { type: "add", filter: { property, operator, value } };
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
function propertyStage(text: string, index: FilterIndex): Suggestions {
  const typed = text.trim();
  const lower = typed.toLowerCase();
  const lead: SuggestionOption[] =
    typed === ""
      ? []
      : [
          {
            key: "use",
            text: `Use: "${typed}"`,
            hint: "Name, namespace or label",
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
      heading: "Properties",
      options: PROPERTIES.filter((p) =>
        p.name.toLowerCase().includes(lower),
      ).map((p) => ({
        key: p.id,
        text: p.name,
        hint: "Property",
        mono: false,
        pick: { type: "text", text: `${p.id} ` },
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
    foot: "Pick a property or a key, or press Enter to search names, namespaces and labels",
  };
}

/** Stage 2: how the property compares. */
function operatorStage(property: FilterProperty): Suggestions {
  const name = propertyText(property);
  return {
    lead: [],
    groups: [
      {
        heading: "Operators",
        options: OPERATORS.filter((o) =>
          operatorsOf(property).includes(o.operator),
        ).map((o) => ({
          key: o.operator,
          text: o.operator,
          hint: o.name,
          mono: true,
          pick: { type: "text", text: `${name} ${o.operator} ` },
        })),
      },
    ],
    foot: `Choose how ${name} compares`,
  };
}

/** Stage 3: the value, from what is typed or from the list's own values. */
function valueStage(parts: FilterParts, index: FilterIndex): Suggestions {
  const { property, operator } = parts;
  const typed = parts.rest.trim();
  const name = propertyText(property);
  const lead: SuggestionOption[] = [];
  if (typed !== "") {
    lead.push({
      key: "use",
      text: `Use: "${typed}"`,
      hint: `${name} ${operator}`,
      mono: false,
      pick: add(property, operator, typed),
    });
  } else if (takesAnyValue(property, operator)) {
    lead.push({
      key: "any",
      text: "Any value",
      hint: `${name} ${operator}`,
      mono: false,
      pick: add(property, operator, ""),
    });
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
export function suggestionsFor(text: string, index: FilterIndex): Suggestions {
  const parts = filterParts(text);
  if (parts) return valueStage(parts, index);
  const property = propertyAlone(text);
  if (property) return operatorStage(property);
  return propertyStage(text, index);
}
