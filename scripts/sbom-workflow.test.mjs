import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./sbom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const makefile = read("Makefile");
const workflows = {
  "ci.yml": read(".github", "workflows", "ci.yml"),
  "release.yml": read(".github", "workflows", "release.yml"),
};

/** One job's text, from its key to the next job's key. */
function job(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("the Makefile pins cargo-cyclonedx and both sbom jobs install that version", () => {
  const pinned = /^CARGO_CYCLONEDX_VERSION := (\S+)$/m.exec(makefile)?.[1];
  assert.ok(pinned, "CARGO_CYCLONEDX_VERSION is not set");
  for (const [name, text] of Object.entries(workflows)) {
    const sbom = job(text, "sbom");
    assert.deepEqual(
      [...sbom.matchAll(/tool: cargo-cyclonedx@(\S+)/g)].map((m) => m[1]),
      [pinned],
      name,
    );
    assert.match(sbom, /^ {10}fallback: none$/m, name);
  }
});

test("make sbom covers the release targets of scripts/sbom.mjs", () => {
  assert.match(makefile, new RegExp(`^SBOM_TARGETS := ${TARGETS.join(" ")}$`, "m"));
});

test("the sbom jobs build with make and pin their actions to commits", () => {
  for (const [name, text] of Object.entries(workflows)) {
    const sbom = job(text, "sbom");
    assert.match(sbom, /^ {8}run: make sbom$/m, name);
    for (const [, use] of sbom.matchAll(/uses: (\S+)/g)) {
      if (use.startsWith("./")) continue;
      assert.match(use, /@[0-9a-f]{40}$/, `${name}: ${use}`);
    }
  }
});

test("CI keeps the SBOM as the run's sbom artifact", () => {
  assert.match(
    job(workflows["ci.yml"], "sbom"),
    /^ {10}name: sbom\n {10}path: tmp\/sbom\/SkoposIDE\.cdx\.json$/m,
  );
});

test("the sbom jobs skip the Linux build libraries, which make sbom does not use", () => {
  // A slow apt mirror once took 19 minutes of the CI job's 20, before make sbom ran.
  for (const [name, text] of Object.entries(workflows)) {
    assert.match(
      job(text, "sbom"),
      /^ {6}- uses: \.\/\.github\/actions\/setup\n {8}with:\n {10}linux-libraries: "false"$/m,
      name,
    );
  }
  const setup = read(".github", "actions", "setup", "action.yml");
  assert.match(setup, /^ {2}linux-libraries:\n(?: {4}.*\n)*? {4}default: "true"$/m);
  const aptSteps = setup.split(/\n(?= {4}- )/).filter((step) => step.includes("apt-get"));
  assert.equal(aptSteps.length, 2);
  for (const step of aptSteps) {
    assert.match(step, /^ {6}if: runner\.os == 'Linux' && inputs\.linux-libraries == 'true'$/m);
  }
});
