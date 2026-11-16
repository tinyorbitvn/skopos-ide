import { useEffect, useState } from "react";
import { isMap, parseAllDocuments } from "yaml";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";

/** The kind whose API docs a YAML tab shows. */
export interface ApiDocsTarget {
  apiVersion: string;
  kind: string;
}

/** How long a create tab waits after the text or the caret last changed (spec L15). */
export const KIND_DELAY_MS = 300;

/** An edit tab's kind: the resource it edits (spec L14). */
export function editTarget(resource: ResourceRef): ApiDocsTarget {
  return {
    apiVersion: resource.group
      ? `${resource.group}/${resource.version}`
      : resource.version,
    kind: resource.kind,
  };
}

/**
 * The kind of the YAML document that holds `caret`, an offset in `text` (spec L15). A document
 * starts at its `---`. Null when that document has no text apiVersion or kind; "unparsed" when
 * the text does not parse.
 */
export function kindAt(
  text: string,
  caret: number,
): ApiDocsTarget | null | "unparsed" {
  const documents = parseAllDocuments(text, { prettyErrors: false });
  if ("empty" in documents) {
    return documents.errors.length > 0 ? "unparsed" : null;
  }
  if (documents.some((document) => document.errors.length > 0)) {
    return "unparsed";
  }
  let holding = documents[0];
  for (const document of documents) {
    if (document.range[0] <= caret) holding = document;
  }
  if (!holding || !isMap(holding.contents)) return null;
  const apiVersion = holding.get("apiVersion");
  const kind = holding.get("kind");
  if (typeof apiVersion !== "string" || typeof kind !== "string") return null;
  if (!apiVersion.trim() || !kind.trim()) return null;
  return { apiVersion: apiVersion.trim(), kind: kind.trim() };
}

function sameTarget(a: ApiDocsTarget | null, b: ApiDocsTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.apiVersion === b.apiVersion && a.kind === b.kind;
}

/**
 * A create tab's kind (spec L15): read from the first text at once, then 300 ms after the text
 * or the caret last changed. Text that does not parse keeps the kind found last. The same kind
 * found again stays the same object.
 */
export function useCreateTarget(
  text: string,
  caret: number,
): ApiDocsTarget | null {
  const [target, setTarget] = useState<ApiDocsTarget | null>(() => {
    const found = kindAt(text, caret);
    return found === "unparsed" ? null : found;
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      const found = kindAt(text, caret);
      if (found === "unparsed") return;
      setTarget((shown) => (sameTarget(shown, found) ? shown : found));
    }, KIND_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, caret]);
  return target;
}
