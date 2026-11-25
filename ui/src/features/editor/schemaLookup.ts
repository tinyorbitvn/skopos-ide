import type { SchemaField } from "../../ipc/generated/SchemaField";
import type { PathStep } from "./yamlPath";

type Wrapper = "list" | "map";

/** The lists and maps around a type, outermost first: `[]map[string]X` → list, map. */
function wrappers(typeLabel: string): Wrapper[] {
  const found: Wrapper[] = [];
  let rest = typeLabel;
  for (;;) {
    if (rest.startsWith("[]")) {
      found.push("list");
      rest = rest.slice(2);
    } else if (rest.startsWith("map[string]")) {
      found.push("map");
      rest = rest.slice("map[string]".length);
    } else {
      return found;
    }
  }
}

/** The fields reached along `path`, and the list items or map keys still expected there. */
function walk(
  fields: SchemaField[],
  path: PathStep[],
): { fields: SchemaField[]; pending: Wrapper[] } | null {
  let current = fields;
  let pending: Wrapper[] = [];
  for (const step of path) {
    if (pending.length > 0) {
      const wanted = pending[0] === "list" ? "item" in step : "key" in step;
      if (!wanted) return null;
      pending = pending.slice(1);
      continue;
    }
    if (!("key" in step)) return null;
    const field = current.find((f) => f.name === step.key);
    if (!field) return null;
    current = field.children;
    pending = wrappers(field.typeLabel);
  }
  return { fields: current, pending };
}

/** The fields of the object that `path` leads to, or null where no object's fields are expected. */
export function childrenAt(
  fields: SchemaField[],
  path: PathStep[],
): SchemaField[] | null {
  const reached = walk(fields, path);
  return reached && reached.pending.length === 0 ? reached.fields : null;
}

/** The field named `key` in that object; null for a map's own keys (spec H3). */
export function fieldAt(
  fields: SchemaField[],
  path: PathStep[],
  key: string,
): SchemaField | null {
  return childrenAt(fields, path)?.find((f) => f.name === key) ?? null;
}
