/**
 * The YAML context at an offset, read line by line so that a half-typed line still gets one
 * (YAML authoring spec H1). Only the document holding the offset is read.
 */

export type PathStep = { key: string } | { item: true };

export type YamlAt =
  /** On a key. `path` leads to the mapping that holds it. */
  | { at: "key"; path: PathStep[]; key: string; start: number; end: number }
  /** After `key:` on the key's line. `partial` is the value up to the offset. */
  | {
      at: "value";
      path: PathStep[];
      key: string;
      partial: string;
      start: number;
    }
  /** Where a new key can start; `siblings` are the keys already in that mapping. */
  | {
      at: "newKey";
      path: PathStep[];
      partial: string;
      start: number;
      siblings: string[];
    }
  | { at: "none" };

export interface YamlContext {
  apiVersion: string | null;
  kind: string | null;
  at: YamlAt;
}

interface ParsedKey {
  name: string;
  column: number;
  end: number;
  rest: string;
  restColumn: number;
}

interface ParsedLine {
  /** Columns of the `- ` markers, left to right. */
  items: number[];
  /** Where the content after the indentation and markers starts. */
  column: number;
  content: string;
  key: ParsedKey | null;
}

interface Frame {
  /** `line:column`, so the same marker gets the same id wherever it is pushed. */
  id: string;
  column: number;
  step: PathStep;
  /** A key whose value is a flow collection: nothing under it is structure. */
  closed: boolean;
}

const NONE: YamlAt = { at: "none" };
const ROOT = "root";
const DOCUMENT_MARK = /^(---|\.\.\.)(\s|$)/;
const KEY =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],&*!|>%@`-][^:#]*?)\s*:(?=\s|$)/;
const WORD = /^[A-Za-z0-9_.\-/]*$/;

function unquote(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"'))
    return name.slice(1, -1).replace(/\\(.)/g, "$1");
  if (name.length >= 2 && name.startsWith("'") && name.endsWith("'"))
    return name.slice(1, -1).replace(/''/g, "'");
  return name;
}

/** A value with its comment and quotes taken off, or null when it is empty. */
function scalarValue(rest: string): string | null {
  const plain = rest.replace(/\s+#.*$/, "").trim();
  return plain ? unquote(plain) : null;
}

function parseLine(line: string): ParsedLine {
  const items: number[] = [];
  let column = line.length - line.trimStart().length;
  while (
    line[column] === "-" &&
    (column + 1 === line.length || line[column + 1] === " ")
  ) {
    items.push(column);
    column += 1;
    while (line[column] === " ") column += 1;
  }
  const content = line.slice(column);
  const match = KEY.exec(content);
  if (!match) return { items, column, content, key: null };
  const raw = match[1];
  let restColumn = column + match[0].length;
  while (line[restColumn] === " ") restColumn += 1;
  return {
    items,
    column,
    content,
    key: {
      name: unquote(raw),
      column,
      end: column + raw.length,
      rest: line.slice(restColumn),
      restColumn,
    },
  };
}

/** A value that starts a block scalar: `|`, `>-`, `|2`, … */
function opensBlock(rest: string): boolean {
  return /^[|>][-+0-9]*\s*(#.*)?$/.test(rest);
}

/** Pops what a key (or, with `item`, a `- `) at `column` closes. */
function popTo(stack: Frame[], column: number, item: boolean): void {
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    // `containers:` then `- name:` at the same indent is a list under `containers`.
    if (
      top.column < column ||
      (item && top.column === column && "key" in top.step)
    )
      return;
    stack.pop();
  }
}

function pushItems(stack: Frame[], columns: number[], line: number): void {
  for (const column of columns) {
    popTo(stack, column, true);
    stack.push({
      id: `${line}:${column}`,
      column,
      step: { item: true },
      closed: false,
    });
  }
}

const topId = (stack: Frame[]) => stack[stack.length - 1]?.id ?? ROOT;
const steps = (stack: Frame[]) => stack.map((frame) => frame.step);
const isClosed = (stack: Frame[]) => stack.some((frame) => frame.closed);

/** The context on the offset's own line, given the frames open before it. */
function contextOnLine(
  open: Frame[],
  parsed: ParsedLine,
  line: string,
  index: number,
  caret: number,
  lineStart: number,
): { at: YamlAt; parent: string | null } {
  const none = { at: NONE, parent: null };
  const stack = [...open];
  pushItems(
    stack,
    parsed.items.filter((column) => column < caret),
    index,
  );
  const key = parsed.key;
  if (key) {
    if (caret < key.column) return none;
    popTo(stack, key.column, false);
    if (isClosed(stack)) return none;
    if (caret <= key.end) {
      return {
        at: {
          at: "key",
          path: steps(stack),
          key: key.name,
          start: lineStart + key.column,
          end: lineStart + key.end,
        },
        parent: null,
      };
    }
    const comment = key.rest.search(/(^|\s)#/);
    const valueEnd =
      key.restColumn + (comment === -1 ? key.rest.length : comment);
    if (caret > valueEnd || /^[{["'|>&*!]/.test(key.rest)) return none;
    const partial =
      caret >= key.restColumn ? line.slice(key.restColumn, caret) : "";
    return {
      at: {
        at: "value",
        path: steps(stack),
        key: key.name,
        partial,
        start: lineStart + key.restColumn,
      },
      parent: null,
    };
  }
  if (parsed.content.startsWith("#")) return none;
  // In the indentation of a blank line, a new key starts at the offset.
  if (caret < parsed.column && line.slice(caret).trim() !== "") return none;
  const column = Math.min(caret, parsed.column);
  const typed = line.slice(column, caret);
  const content = line.slice(column).trim();
  if (!WORD.test(content) || !content.startsWith(typed)) return none;
  popTo(stack, column, false);
  if (isClosed(stack)) return none;
  return {
    at: {
      at: "newKey",
      path: steps(stack),
      partial: typed,
      start: lineStart + column,
      siblings: [],
    },
    parent: topId(stack),
  };
}

/** The YAML context at `offset` in `text`. */
export function yamlContextAt(text: string, offset: number): YamlContext {
  const lines = text.split("\n");
  const starts: number[] = [];
  let position = 0;
  for (const line of lines) {
    starts.push(position);
    position += line.length + 1;
  }
  let caretLine = lines.length - 1;
  for (let i = 0; i < lines.length; i += 1) {
    if (offset <= starts[i] + lines[i].length) {
      caretLine = i;
      break;
    }
  }
  let first = 0;
  for (let i = caretLine - 1; i >= 0; i -= 1) {
    if (DOCUMENT_MARK.test(lines[i])) {
      first = i + 1;
      break;
    }
  }
  let last = lines.length - 1;
  for (let i = caretLine + 1; i < lines.length; i += 1) {
    if (DOCUMENT_MARK.test(lines[i])) {
      last = i - 1;
      break;
    }
  }

  let apiVersion: string | null = null;
  let kind: string | null = null;
  const stack: Frame[] = [];
  /** Every key with the id of the frame that holds it. */
  const keys: { name: string; parent: string }[] = [];
  let blockColumn: number | null = null;
  let at: YamlAt = NONE;
  let newKeyParent: string | null = null;

  for (let i = first; i <= last; i += 1) {
    const line = lines[i];
    if (blockColumn !== null) {
      const indent = line.length - line.trimStart().length;
      // A block scalar's text: the offset in it has no context.
      if (line.trim() === "" || indent > blockColumn) continue;
      blockColumn = null;
    }
    const parsed = parseLine(line);
    if (i === caretLine && !DOCUMENT_MARK.test(line)) {
      const found = contextOnLine(
        stack,
        parsed,
        line,
        i,
        offset - starts[i],
        starts[i],
      );
      at = found.at;
      newKeyParent = found.parent;
    }
    pushItems(stack, parsed.items, i);
    const key = parsed.key;
    if (!key) continue;
    popTo(stack, key.column, false);
    if (stack.length === 0 && parsed.items.length === 0) {
      if (key.name === "apiVersion") apiVersion = scalarValue(key.rest);
      if (key.name === "kind") kind = scalarValue(key.rest);
    }
    if (!isClosed(stack)) keys.push({ name: key.name, parent: topId(stack) });
    stack.push({
      id: `${i}:${key.column}`,
      column: key.column,
      step: { key: key.name },
      closed: /^[{[]/.test(key.rest),
    });
    if (opensBlock(key.rest)) blockColumn = key.column;
  }

  if (at.at === "newKey") {
    const parent = newKeyParent;
    at = {
      ...at,
      siblings: keys.filter((k) => k.parent === parent).map((k) => k.name),
    };
  }
  return { apiVersion, kind, at };
}
