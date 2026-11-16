import type { SchemaField } from "../../ipc/generated/SchemaField";

/** A field with its place in the tree. */
export interface FieldNode {
  field: SchemaField;
  /** Unique in the tree: the names from the top joined by ".", each with its type's suffix. */
  path: string;
  parent: FieldNode | null;
  /** 1 at the top, as `aria-level` counts. */
  level: number;
  children: FieldNode[];
}

export interface FieldIndex {
  roots: FieldNode[];
  /** Every field, depth first. */
  all: FieldNode[];
}

const COLLECTIONS = /^(?:\[\]|map\[string\])*/;

/** What a field's type adds to its path: "[]" per array and "{}" per map (spec L22). */
export function pathSuffix(typeLabel: string): string {
  return (COLLECTIONS.exec(typeLabel)?.[0] ?? "").replaceAll(
    "map[string]",
    "{}",
  );
}

export function indexFields(fields: SchemaField[]): FieldIndex {
  const all: FieldNode[] = [];
  function build(field: SchemaField, parent: FieldNode | null): FieldNode {
    const name = `${field.name}${pathSuffix(field.typeLabel)}`;
    const node: FieldNode = {
      field,
      path: parent ? `${parent.path}.${name}` : name,
      parent,
      level: parent ? parent.level + 1 : 1,
      children: [],
    };
    all.push(node);
    node.children = field.children.map((child) => build(child, node));
    return node;
  }
  const roots = fields.map((field) => build(field, null));
  return { roots, all };
}

/** "1 field" or "‹n› fields" (spec L20). */
export function fieldsLabel(count: number): string {
  return count === 1 ? "1 field" : `${count} fields`;
}

export interface FieldSearch {
  /** The paths of the fields whose name holds the query. */
  matches: Set<string>;
  /** The matches and their ancestors: what the tree shows. */
  shown: Set<string>;
  /** The ancestors of the matches, which the search opens. */
  expanded: Set<string>;
}

/**
 * The fields whose name holds `query` as plain text, ignoring case and the spaces around it;
 * null when the query is blank (spec L20).
 */
export function searchFields(
  index: FieldIndex,
  query: string,
): FieldSearch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const matches = new Set<string>();
  const shown = new Set<string>();
  const expanded = new Set<string>();
  for (const node of index.all) {
    if (!node.field.name.toLowerCase().includes(needle)) continue;
    matches.add(node.path);
    shown.add(node.path);
    for (let up = node.parent; up; up = up.parent) {
      shown.add(up.path);
      expanded.add(up.path);
    }
  }
  return { matches, shown, expanded };
}

export interface TreeRow {
  node: FieldNode;
  expandable: boolean;
  expanded: boolean;
}

/**
 * The rows on screen, top to bottom (spec L20, L21): the children of each open field. During a
 * search, the top level and the children of the search's ancestors are cut to the matches and
 * their ancestors; a field the user opens shows all its children.
 */
export function visibleRows(
  index: FieldIndex,
  expanded: ReadonlySet<string>,
  search: FieldSearch | null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  function walk(nodes: FieldNode[], cut: boolean): void {
    for (const node of nodes) {
      if (cut && search && !search.shown.has(node.path)) continue;
      const expandable = node.children.length > 0;
      const open = expandable && expanded.has(node.path);
      rows.push({ node, expandable, expanded: open });
      if (open) walk(node.children, search?.expanded.has(node.path) ?? false);
    }
  }
  walk(index.roots, search !== null);
  return rows;
}

/** `set` with `path` added (`on`) or removed, as a new set. */
export function withPath(
  set: ReadonlySet<string>,
  path: string,
  on: boolean,
): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(path);
  else next.delete(path);
  return next;
}

/**
 * What `key` does in the tree whose row `focus` has the focus (spec L23): the row to focus and
 * select, and what is open. Up and Down move; Right opens, or moves to the first child of an
 * open field; Left closes, or moves to the parent; Home and End go to the first and last rows.
 * Null for a key the tree leaves alone. With no focus yet, the first row has it.
 */
export function treeKey(
  key: string,
  rows: TreeRow[],
  focus: string | null,
  expanded: ReadonlySet<string>,
): { focus: string; expanded: ReadonlySet<string> } | null {
  if (rows.length === 0) return null;
  const at = Math.max(
    0,
    rows.findIndex((row) => row.node.path === focus),
  );
  const row = rows[at];
  const to = (index: number) => ({ focus: rows[index].node.path, expanded });
  switch (key) {
    case "ArrowDown":
      return to(Math.min(rows.length - 1, at + 1));
    case "ArrowUp":
      return to(Math.max(0, at - 1));
    case "Home":
      return to(0);
    case "End":
      return to(rows.length - 1);
    case "ArrowRight":
      if (!row.expandable) return to(at);
      if (!row.expanded) {
        return {
          focus: row.node.path,
          expanded: withPath(expanded, row.node.path, true),
        };
      }
      return rows[at + 1]?.node.parent === row.node ? to(at + 1) : to(at);
    case "ArrowLeft":
      if (row.expanded) {
        return {
          focus: row.node.path,
          expanded: withPath(expanded, row.node.path, false),
        };
      }
      return row.node.parent
        ? { focus: row.node.parent.path, expanded }
        : to(at);
    default:
      return null;
  }
}
