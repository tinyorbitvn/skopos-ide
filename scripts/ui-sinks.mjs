// The ways a page hands text to the browser as markup, as code or as an address to load.
// `ui-sinks.test.mjs` keeps `ui/src` free of them. A comment that spells one out is found
// too: word it differently.

const SINKS = [
  { name: "dangerouslySetInnerHTML", pattern: /\bdangerouslySetInnerHTML\b/g },
  // An assignment, not a read or a comparison.
  { name: "innerHTML", pattern: /\.innerHTML\s*\+?=(?!=)/g },
  { name: "outerHTML", pattern: /\.outerHTML\s*\+?=(?!=)/g },
  { name: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/g },
  { name: "document.write", pattern: /\bdocument\.write(?:ln)?\s*\(/g },
  { name: "window.open", pattern: /\bwindow\.open\s*\(/g },
  // The global function, not a method of that name.
  { name: "eval", pattern: /(?<![.\w$])eval\s*\(/g },
  { name: "new Function", pattern: /\bnew\s+Function\s*\(/g },
  // A link the webview follows itself. An arrow function's `=>` does not end the tag.
  { name: "a href", pattern: /<a\s(?:=>|[^>])*?\bhref\b/g },
  // Leaving the page. A hash route and a reload stay on it.
  { name: "location", pattern: /\blocation\.(?:href\s*=(?!=)|(?:assign|replace)\s*\()/g },
];

/** Every sink in the text, in its order, as `{ line, name }` with lines counted from 1. */
export function findSinks(text) {
  const found = [];
  for (const { name, pattern } of SINKS) {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index, name });
  }
  found.sort((a, b) => a.at - b.at);
  return found.map(({ at, name }) => ({ line: text.slice(0, at).split("\n").length, name }));
}
