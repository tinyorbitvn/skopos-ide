import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CARD, OUT, cardFiles, cardRefs, missingRefs, parseArgs } from "./social-image.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("parseArgs", () => {
  test("writes the site's card unless --out names another file", () => {
    assert.deepEqual(parseArgs([]), { out: OUT });
    assert.deepEqual(parseArgs(["--out", "tmp/card.png"]), { out: "tmp/card.png" });
  });

  test("rejects unknown arguments and --out without a file", () => {
    assert.throws(() => parseArgs(["--size", "2"]), /unknown argument: --size/);
    assert.throws(() => parseArgs(["--out"]), /unknown argument: --out/);
  });
});

describe("card", () => {
  const html = fs.readFileSync(path.join(ROOT, "scripts", "social-card.html"), "utf8");

  test("cardRefs lists what the markup loads", () => {
    assert.deepEqual(cardRefs('<link rel="stylesheet" href="site.css"><img src="images/a.png" alt="">'), [
      "site.css",
      "images/a.png",
    ]);
  });

  test("loads only files the script serves, and every one of them exists", () => {
    assert.deepEqual(missingRefs(ROOT), []);
    const refs = cardRefs(html);
    for (const rel of ["tokens.css", "site.css", "ribbon.js", "icon.svg"]) assert.ok(refs.includes(rel), rel);
    assert.ok(refs.some((rel) => /^images\/canvas-[a-z-]+\.png$/.test(rel)));
    assert.ok(cardFiles(ROOT).has("card.html"));
  });

  test("is the size of the card, draws the ribbon still and loads nothing remote", () => {
    assert.match(html, new RegExp(`width: ${CARD.width}px;\\s+height: ${CARD.height}px;`));
    assert.match(html, /<canvas class="ribbon" data-ribbon /);
    assert.doesNotMatch(html, /https?:|@import/);
  });
});
