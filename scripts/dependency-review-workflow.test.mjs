import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "dependency-review.yml"),
  "utf8",
);

test("dependency review runs on pull requests and on pushes to main", () => {
  assert.match(
    workflow,
    /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/m,
  );
});

test("dependency review only reads the repository", () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(workflow, /: write\b/);
});

test("every action is pinned to a commit", () => {
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const use of uses) {
    assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, use);
  }
});

test("the comparison skips without a base, tries three times, then is checked", () => {
  assert.match(
    workflow,
    /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/,
  );
  assert.match(
    workflow,
    /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.match(workflow, /echo "skip=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /for attempt in 1 2 3; do/);
  assert.match(
    workflow,
    /dependency-graph\/compare\/\$BASE_SHA\.\.\.\$HEAD_SHA/,
  );
  assert.match(workflow, /if: steps\.compare\.outputs\.skip != 'true'/);
  assert.match(
    workflow,
    /run: node scripts\/advisories\.mjs review --changes "\$RUNNER_TEMP\/changes\.json"/,
  );
});
