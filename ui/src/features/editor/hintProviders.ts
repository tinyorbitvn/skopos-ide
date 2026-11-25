import type * as Monaco from "monaco-editor/editor/editor.api";
import type { KindSchema } from "../../ipc/generated/KindSchema";
import { loadKindSchema } from "./apiDocsCache";
import type { ApiDocsTarget } from "./apiDocsKind";
import {
  apiVersionItems,
  fieldItems,
  type Hint,
  hoverText,
  kindItems,
  topLevelItems,
  valueItems,
} from "./schemaHints";
import { childrenAt, fieldAt } from "./schemaLookup";
import type { ServedKind } from "./servedKinds";
import { yamlContextAt } from "./yamlPath";

/** What a YAML editor's hints read: its cluster, its kind when fixed, and the served kinds. */
export interface HintSource {
  clusterId: string;
  /** An edit tab's kind (spec H2). A create tab reads the kind from each document. */
  fixedTarget: ApiDocsTarget | null;
  served: ServedKind[];
}

const sources = new Map<string, HintSource>();

/** Registers a model's source; null removes it when the editor unmounts (spec H2). */
export function setHintSource(uri: string, source: HintSource | null): void {
  if (source) sources.set(uri, source);
  else sources.delete(uri);
}

async function schemaFor(
  source: HintSource,
  apiVersion: string | null,
  kind: string | null,
): Promise<KindSchema | null> {
  const target =
    source.fixedTarget ?? (apiVersion && kind ? { apiVersion, kind } : null);
  if (!target) return null;
  try {
    return await loadKindSchema(source.clusterId, target);
  } catch {
    // The API docs panel reports schema errors; hints stay quiet (spec H9).
    return null;
  }
}

/** The hover at `offset`, or null (spec H3, H9). */
export async function hoverAt(
  source: HintSource,
  text: string,
  offset: number,
): Promise<{ markdown: string; start: number; end: number } | null> {
  const context = yamlContextAt(text, offset);
  if (context.at.at !== "key") return null;
  const schema = await schemaFor(source, context.apiVersion, context.kind);
  if (!schema) return null;
  const field = fieldAt(schema.fields, context.at.path, context.at.key);
  return field
    ? {
        markdown: hoverText(field),
        start: context.at.start,
        end: context.at.end,
      }
    : null;
}

/** The completion items at `offset` and where the replaced text starts, or null (spec H4, H5, H7, H9). */
export async function completionsAt(
  source: HintSource,
  text: string,
  offset: number,
): Promise<{ items: Hint[]; start: number } | null> {
  const context = yamlContextAt(text, offset);
  const { at } = context;
  if (at.at === "none") return null;
  const top = at.path.length === 0;
  if (at.at === "value" && top && at.key === "kind" && !source.fixedTarget)
    return { items: kindItems(source.served), start: at.start };
  if (
    at.at === "value" &&
    top &&
    at.key === "apiVersion" &&
    !source.fixedTarget
  ) {
    return {
      items: apiVersionItems(source.served, context.kind),
      start: at.start,
    };
  }
  const schema = await schemaFor(source, context.apiVersion, context.kind);
  if (!schema) {
    if (at.at === "newKey" && top && !source.fixedTarget)
      return { items: topLevelItems(at.siblings), start: at.start };
    return null;
  }
  if (at.at === "value") {
    const field = fieldAt(schema.fields, at.path, at.key);
    return field ? { items: valueItems(field), start: at.start } : null;
  }
  const children = childrenAt(schema.fields, at.path);
  if (!children) return null;
  if (at.at === "key") {
    // Renaming a key: the name only, over the whole key.
    const items = fieldItems(children, [], at.path).map((hint) => ({
      ...hint,
      insertText: hint.label,
      snippet: false,
    }));
    return { items, start: at.start };
  }
  return { items: fieldItems(children, at.siblings, at.path), start: at.start };
}

let installed = false;

/** Registers the YAML hover and completion providers once (spec H2). */
export function installHintProviders(monaco: typeof Monaco): void {
  if (installed) return;
  installed = true;
  monaco.languages.registerHoverProvider("yaml", {
    async provideHover(model, position) {
      const source = sources.get(model.uri.toString());
      if (!source) return null;
      const hover = await hoverAt(
        source,
        model.getValue(),
        model.getOffsetAt(position),
      );
      if (!hover) return null;
      const start = model.getPositionAt(hover.start);
      const end = model.getPositionAt(hover.end);
      return {
        range: new monaco.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        ),
        contents: [
          { value: hover.markdown, isTrusted: false, supportHtml: false },
        ],
      };
    },
  });
  monaco.languages.registerCompletionItemProvider("yaml", {
    triggerCharacters: [" "],
    async provideCompletionItems(model, position) {
      const source = sources.get(model.uri.toString());
      if (!source) return { suggestions: [] };
      const offset = model.getOffsetAt(position);
      const result = await completionsAt(source, model.getValue(), offset);
      if (!result) return { suggestions: [] };
      const start = model.getPositionAt(result.start);
      const range = new monaco.Range(
        start.lineNumber,
        start.column,
        position.lineNumber,
        position.column,
      );
      return {
        suggestions: result.items.map((hint) => ({
          label: hint.label,
          kind: hint.snippet
            ? monaco.languages.CompletionItemKind.Property
            : monaco.languages.CompletionItemKind.Value,
          insertText: hint.insertText,
          insertTextRules: hint.snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          detail: hint.detail,
          documentation: hint.documentation
            ? {
                value: hint.documentation.replace(
                  /[\\`*_{}[\]()<>#|!~]/g,
                  (c) => `\\${c}`,
                ),
                isTrusted: false,
                supportHtml: false,
              }
            : undefined,
          sortText: hint.sortText,
          range,
        })),
      };
    },
  });
}
