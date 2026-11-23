import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addedAdvisories,
  breaksPolicy,
  normalizeSeverity,
  openAlerts,
  report,
  summaryTable,
} from "./advisories.mjs";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "advisories.mjs",
);
// make check runs inside GitHub Actions too: never write to the real job summary.
const QUIET_ENV = {
  ...process.env,
  GITHUB_ACTIONS: "",
  GITHUB_STEP_SUMMARY: "",
};

/** One change of a dependency-graph comparison, shaped like GitHub's reply. */
function change(type, ecosystem, name, version, vulnerabilities = []) {
  return {
    change_type: type,
    manifest: ecosystem === "cargo" ? "Cargo.lock" : "pnpm-lock.yaml",
    ecosystem,
    name,
    version,
    package_url: `pkg:${ecosystem}/${name}@${version}`,
    scope: "runtime",
    vulnerabilities: vulnerabilities.map(
      ([id, severity, summary = "Something is wrong"]) => ({
        severity,
        advisory_ghsa_id: id,
        advisory_summary: summary,
        advisory_url: `https://github.com/advisories/${id}`,
      }),
    ),
  };
}

/** One Dependabot alert, shaped like GitHub's reply. */
function alert(state, ecosystem, name, id, severity) {
  return {
    number: 1,
    state,
    html_url: "https://github.com/vanlongme/skopos-ide/security/dependabot/1",
    dependency: {
      package: { ecosystem, name },
      manifest_path: ecosystem === "rust" ? "Cargo.lock" : "pnpm-lock.yaml",
      scope: "runtime",
    },
    security_advisory: { ghsa_id: id, severity, summary: "Something is wrong" },
    security_vulnerability: { severity, vulnerable_version_range: "< 2.0.0" },
  };
}

test("every Rust advisory breaks the policy, whatever its severity", () => {
  for (const ecosystem of ["cargo", "rust", "Cargo"]) {
    assert.equal(breaksPolicy({ ecosystem, severity: "low" }), true, ecosystem);
  }
});

test("an npm advisory breaks the policy at high or critical only", () => {
  assert.equal(breaksPolicy({ ecosystem: "npm", severity: "low" }), false);
  assert.equal(breaksPolicy({ ecosystem: "npm", severity: "moderate" }), false);
  assert.equal(breaksPolicy({ ecosystem: "npm", severity: "medium" }), false);
  assert.equal(breaksPolicy({ ecosystem: "npm", severity: "high" }), true);
  assert.equal(breaksPolicy({ ecosystem: "npm", severity: "CRITICAL" }), true);
});

test("an advisory with no known severity counts as critical", () => {
  for (const severity of [undefined, null, "", "unknown"]) {
    assert.equal(
      breaksPolicy({ ecosystem: "npm", severity }),
      true,
      String(severity),
    );
  }
});

test("alerts say medium where the dependency graph says moderate", () => {
  assert.equal(normalizeSeverity("medium"), "moderate");
  assert.equal(normalizeSeverity(" High "), "high");
});

test("a change counts the advisories its added packages bring", () => {
  const found = addedAdvisories([
    change("added", "npm", "lodash", "4.17.0", [
      ["GHSA-aaaa-aaaa-aaaa", "critical"],
    ]),
    change("added", "npm", "left-pad", "1.3.0"),
    change("removed", "npm", "lodash", "4.17.21"),
  ]);
  assert.deepEqual(
    found.map((f) => [f.id, f.severity, f.name, f.version, f.manifest]),
    [["GHSA-aaaa-aaaa-aaaa", "critical", "lodash", "4.17.0", "pnpm-lock.yaml"]],
  );
});

test("bumping a package whose advisory the base already has adds nothing", () => {
  const glib = [["GHSA-wrw7-89jp-8q8g", "moderate"]];
  assert.deepEqual(
    addedAdvisories([
      change("removed", "cargo", "glib", "0.18.5", glib),
      change("added", "cargo", "glib", "0.18.6", glib),
    ]),
    [],
  );
  const found = addedAdvisories([
    change("removed", "cargo", "glib", "0.18.5", glib),
    change("added", "cargo", "glib", "0.18.6", [
      ...glib,
      ["GHSA-bbbb-bbbb-bbbb", "low"],
    ]),
  ]);
  assert.deepEqual(
    found.map((f) => f.id),
    ["GHSA-bbbb-bbbb-bbbb"],
  );
});

test("a comparison that is not an array of changes is refused", () => {
  assert.throws(
    () => addedAdvisories({ message: "Not Found" }),
    /not a JSON array/,
  );
});

test("open alerts come one per line, and only open ones count", () => {
  const text = [
    JSON.stringify(alert("open", "rust", "url", "GHSA-hrj5-67jp-wqp9", "medium")),
    "",
    JSON.stringify(
      alert("dismissed", "rust", "glib", "GHSA-wrw7-89jp-8q8g", "medium"),
    ),
    JSON.stringify(
      alert("open", "npm", "dompurify", "GHSA-cccc-cccc-cccc", "low"),
    ),
  ].join("\n");
  assert.deepEqual(
    openAlerts(text).map((f) => [
      f.id,
      f.severity,
      f.ecosystem,
      f.name,
      f.manifest,
    ]),
    [
      ["GHSA-hrj5-67jp-wqp9", "moderate", "rust", "url", "Cargo.lock"],
      ["GHSA-cccc-cccc-cccc", "low", "npm", "dompurify", "pnpm-lock.yaml"],
    ],
  );
  assert.deepEqual(openAlerts(""), []);
  assert.throws(() => openAlerts("[{]"), /line 1 is not a JSON alert/);
});

test("the report fails on a breach and warns about the rest", () => {
  const findings = addedAdvisories([
    change("added", "cargo", "url", "2.5.8", [["GHSA-hrj5-67jp-wqp9", "low"]]),
    change("added", "npm", "dompurify", "3.4.15", [
      ["GHSA-cccc-cccc-cccc", "low"],
    ]),
  ]);
  const { lines, broken } = report(findings);
  assert.equal(broken, 1);
  assert.match(
    lines[0],
    /^FAIL url 2\.5\.8 in Cargo\.lock: low GHSA-hrj5-67jp-wqp9 /,
  );
  assert.match(
    lines[1],
    /^warn dompurify 3\.4\.15 in pnpm-lock\.yaml: low GHSA-cccc-cccc-cccc /,
  );
  assert.equal(lines.at(-1), "2 advisories, 1 against the policy.");
  assert.deepEqual(report([]).lines, ["No advisories."]);
});

test("advisory text never starts a workflow command or breaks a line", () => {
  const findings = addedAdvisories([
    change("added", "npm", "evil", "1.0.0", [
      ["GHSA-dddd-dddd-dddd", "high", "line one\n::add-mask::x\r\n100% bad"],
    ]),
  ]);
  const { lines } = report(findings, { annotate: true });
  assert.equal(lines.length, 2);
  assert.ok(!lines[0].includes("\n") && !lines[0].includes("\r"));
  assert.match(
    lines[0],
    /^::error title=GHSA-dddd-dddd-dddd::evil 1\.0\.0 in pnpm-lock\.yaml: high GHSA-dddd-dddd-dddd line one ::add-mask::x 100%25 bad /,
  );
  assert.match(summaryTable([{ ...findings[0], manifest: "a|b" }]), /a\\\|b/);
});

test("review exits 1 on a breach and writes the job summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisories-"));
  const changes = path.join(dir, "changes.json");
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(
    changes,
    JSON.stringify([
      change("added", "cargo", "url", "2.5.8", [["GHSA-hrj5-67jp-wqp9", "low"]]),
    ]),
  );
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "review", "--changes", changes],
    {
      encoding: "utf8",
      env: { ...QUIET_ENV, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary },
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /^::error title=GHSA-hrj5-67jp-wqp9::url 2\.5\.8/m);
  assert.match(
    fs.readFileSync(summary, "utf8"),
    /\| Fails \| low \| url 2\.5\.8 \| Cargo\.lock \|/,
  );
});

test("review passes with no new advisories; a bad file or command fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisories-"));
  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, "[]");
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: QUIET_ENV,
    });
  const ok = run("review", "--changes", empty);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "No advisories.\n");
  const missing = run("review", "--changes", path.join(dir, "missing.json"));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^advisories: /);
  const usage = run("scan");
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: node scripts\/advisories\.mjs review/);
});
