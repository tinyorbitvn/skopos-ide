// Every command is open to whatever script runs in a window, so the interface must never
// hand text from a cluster to the page as markup, as code or as an address to load. This
// keeps it that way: `make check` fails when one of those ways appears in `ui/src`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findSinks } from "./ui-sinks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = path.join(ROOT, "ui", "src");

const names = (text) => findSinks(text).map((found) => found.name);

/** The interface's own sources: no tests, and none of the helpers only tests load. */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return file === path.join(SOURCES, "test") ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

test("each way of handing text to the page as markup, code or an address is found", () => {
  const cases = [
    ["el.innerHTML = text;", "innerHTML"],
    ["el.innerHTML += text;", "innerHTML"],
    ["el.outerHTML = text;", "outerHTML"],
    ["<div dangerouslySetInnerHTML={{ __html: text }} />", "dangerouslySetInnerHTML"],
    ['el.insertAdjacentHTML("beforeend", text);', "insertAdjacentHTML"],
    ["document.write(text);", "document.write"],
    ["document.writeln(text);", "document.write"],
    ["window.open(url);", "window.open"],
    ["eval(text);", "eval"],
    ["const run = new Function(text);", "new Function"],
    ["<a href={url}>docs</a>", "a href"],
    ["<a\n  className={styles.link}\n  href={url}\n>", "a href"],
    ["<a onClick={() => pick(url)} href={url}>", "a href"],
    ["window.location.href = url;", "location"],
    ["location.assign(url);", "location"],
    ["location.replace(url);", "location"],
  ];
  for (const [code, name] of cases) assert.deepEqual(names(code), [name], code);
});

test("reading markup, look-alike names and routes inside the app are left alone", () => {
  for (const code of [
    "const html = el.innerHTML;",
    'if (el.innerHTML === "") return;',
    "el.textContent = text;",
    "evaluate(text);",
    "retrieval(text);",
    "parser.eval(text);",
    "const opener = window.opener;",
    "<abbr title={href}>x</abbr>",
    "<Anchor href={url} />",
    "<a onClick={open}>docs</a>",
    "const { href } = new URL(raw);",
    "if (location.href === start) return;",
    "window.location.hash = route;",
    "window.location.reload();",
  ]) {
    assert.deepEqual(names(code), [], code);
  }
});

test("a finding names its line, and findings come in the order of the text", () => {
  assert.deepEqual(findSinks("const a = 1;\n\nel.innerHTML = a;\neval(a);\n"), [
    { line: 3, name: "innerHTML" },
    { line: 4, name: "eval" },
  ]);
});

test("the interface has none outside its tests", () => {
  const files = sourceFiles(SOURCES);
  assert.ok(files.length > 100, `only ${files.length} source files were read`);
  const found = files.flatMap((file) =>
    findSinks(fs.readFileSync(file, "utf8")).map(
      (sink) => `${path.relative(ROOT, file)}:${sink.line} ${sink.name}`,
    ),
  );
  assert.deepEqual(
    found,
    [],
    "ui/src must show text as text and open links through open_external; see scripts/ui-sinks.mjs",
  );
});
