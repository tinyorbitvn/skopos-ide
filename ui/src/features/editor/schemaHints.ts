import type { SchemaField } from "../../ipc/generated/SchemaField";
import type { ServedKind } from "./servedKinds";
import { SERVER_METADATA } from "./validate";
import type { PathStep } from "./yamlPath";

/** One completion item, as plain data; `hintProviders.ts` turns it into Monaco's. */
export interface Hint {
  label: string;
  insertText: string;
  /** `insertText` is a snippet with `$0` where the cursor goes. */
  snippet: boolean;
  detail?: string;
  documentation?: string;
  sortText: string;
}

/** Markdown special characters, escaped so a description is plain text (spec H3). */
function escaped(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#|!~]/g, (c) => `\\${c}`);
}

function code(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `\`${text.replace(/`/g, "'")}\``;
}

/** A key's hover: name, type, `required`, default, values and description (spec H3). */
export function hoverText(field: SchemaField): string {
  const parts = [
    `**${escaped(field.name)}** ${code(field.typeLabel)}${field.required ? " · required" : ""}`,
  ];
  if (field.defaultValue !== null)
    parts.push(`Default: ${code(field.defaultValue)}`);
  if (field.enumValues.length > 0)
    parts.push(`One of: ${field.enumValues.map(code).join(", ")}`);
  if (field.description) parts.push(escaped(field.description));
  return parts.join("\n\n");
}

/** What picking a field inserts (spec H4). */
function insertFor(field: SchemaField): string {
  if (field.typeLabel.startsWith("[]")) return `${field.name}:\n  - $0`;
  const scalar = ["string", "integer", "number", "boolean", "int-or-string"];
  const opaque =
    field.children.length === 0 &&
    !field.typeLabel.startsWith("map[") &&
    field.typeLabel !== "object";
  if (scalar.includes(field.typeLabel) || opaque) {
    return `${field.name}: $0`;
  }
  return `${field.name}:\n  $0`;
}

function samePath(path: PathStep[], keys: string[]): boolean {
  return (
    path.length === keys.length &&
    path.every((step, i) => "key" in step && step.key === keys[i])
  );
}

/** The fields not present yet, required first and then A to Z, without the excluded ones (H4, H6). */
export function fieldItems(
  children: SchemaField[],
  siblings: string[],
  path: PathStep[],
): Hint[] {
  const top = path.length === 0;
  const metadata = samePath(path, ["metadata"]);
  return children
    .filter((f) => !siblings.includes(f.name))
    .filter((f) => !(top && f.name === "status"))
    .filter((f) => !(metadata && SERVER_METADATA.includes(f.name)))
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) || a.name.localeCompare(b.name),
    )
    .map((f, index) => ({
      label: f.name,
      insertText: insertFor(f),
      snippet: true,
      detail: f.required ? `${f.typeLabel} · required` : f.typeLabel,
      documentation: f.description || undefined,
      sortText: String(index).padStart(4, "0"),
    }));
}

function plainItems(values: string[], detail?: string): Hint[] {
  return values.map((value, index) => ({
    label: value,
    insertText: value,
    snippet: false,
    detail,
    sortText: String(index).padStart(4, "0"),
  }));
}

/** A value's choices: its enum values, or true and false (spec H5). */
export function valueItems(field: SchemaField): Hint[] {
  if (field.enumValues.length > 0) return plainItems(field.enumValues);
  if (field.typeLabel === "boolean") return plainItems(["true", "false"]);
  return [];
}

const TOP_LEVEL = [
  "apiVersion",
  "kind",
  "metadata",
  "spec",
  "data",
  "stringData",
];

/** The top-level keys offered before the document has a kind (spec H7). */
export function topLevelItems(siblings: string[]): Hint[] {
  return TOP_LEVEL.filter((name) => !siblings.includes(name)).map(
    (name, index) => ({
      label: name,
      insertText:
        name === "metadata" ||
        name === "spec" ||
        name === "data" ||
        name === "stringData"
          ? `${name}:\n  $0`
          : `${name}: $0`,
      snippet: true,
      sortText: String(index).padStart(4, "0"),
    }),
  );
}

/** The kinds the cluster serves, A to Z (spec H5). */
export function kindItems(served: ServedKind[]): Hint[] {
  return plainItems([...new Set(served.map((s) => s.kind))].sort());
}

/** The versions serving `kind`, or every served version when there is no kind (spec H5). */
export function apiVersionItems(
  served: ServedKind[],
  kind: string | null,
): Hint[] {
  const versions = served
    .filter((s) => kind === null || s.kind === kind)
    .map((s) => s.apiVersion);
  return plainItems([...new Set(versions)].sort());
}
