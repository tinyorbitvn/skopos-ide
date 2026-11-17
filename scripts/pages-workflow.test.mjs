import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const pages = read(".github", "workflows", "pages.yml");

test("pages runs after each successful run of the workflow named release", () => {
  assert.match(read(".github", "workflows", "release.yml"), /^name: release$/m);
  assert.match(pages, /^ {2}workflow_run:\n {4}workflows: \[release\]\n {4}types: \[completed\]$/m);
  assert.match(
    pages,
    /^ {4}if: github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.conclusion == 'success'$/m,
  );
});

test("pages runs on pushes to main that touch the site's sources, and by hand", () => {
  assert.match(pages, /^ {2}push:\n {4}branches: \[main\]\n {4}paths:\n/m);
  const paths = [...pages.matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(paths, [
    "site/**",
    "scripts/build-site.mjs",
    "ui/src/design/tinyorbit.css",
    "ui/src/design/glyphPaths.ts",
    "assets/icon.svg",
    ".github/workflows/pages.yml",
  ]);
  for (const p of paths) assert.ok(fs.existsSync(path.join(ROOT, p.replace("/**", ""))), p);
  assert.match(pages, /^ {2}workflow_dispatch:$/m);
});

test("pages uses the current majors of the Pages actions and the deploy permissions", () => {
  for (const action of [
    "actions/configure-pages@v6",
    "actions/upload-pages-artifact@v5",
    "actions/deploy-pages@v5",
  ]) {
    assert.ok(pages.includes(`uses: ${action}`), action);
  }
  assert.match(pages, /^permissions:\n {2}contents: read$/m);
  assert.match(pages, /^ {6}pages: write$/m);
  assert.match(pages, /^ {6}id-token: write$/m);
  assert.match(pages, /^ {6}name: github-pages$/m);
  assert.match(pages, /^concurrency:\n {2}group: pages\n {2}cancel-in-progress: false$/m);
});

test("pages builds outside the checkout and uploads that folder", () => {
  assert.ok(pages.includes('run: node scripts/build-site.mjs --out "$RUNNER_TEMP/site"'));
  assert.ok(pages.includes("path: ${{ runner.temp }}/site"));
  assert.ok(pages.includes("GH_TOKEN: ${{ github.token }}"));
});
