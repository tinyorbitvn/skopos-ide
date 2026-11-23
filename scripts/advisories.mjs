// Applies the dependency advisory policy to a dependency-graph comparison (the
// dependency-review workflow) or to the open Dependabot alerts (make audit). Any Rust
// advisory fails, any other fails at high or critical, the rest are warnings. See
// docs/releasing.md, "Dependencies and advisories".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = [
  "usage: node scripts/advisories.mjs review --changes <compare.json>",
  "       node scripts/advisories.mjs alerts --file <alerts.ndjson>",
].join("\n");

const RUST = new Set(["cargo", "rust"]);
const KNOWN = new Set(["low", "moderate", "high", "critical"]);

/** Dependabot alerts say medium where the dependency graph says moderate. */
export function normalizeSeverity(severity) {
  const value = String(severity ?? "")
    .trim()
    .toLowerCase();
  return value === "medium" ? "moderate" : value;
}

/**
 * True when an advisory fails CI: every Rust advisory, and any other at high or
 * critical. A severity GitHub did not give counts as critical.
 */
export function breaksPolicy({ ecosystem, severity }) {
  if (RUST.has(String(ecosystem ?? "").toLowerCase())) return true;
  const value = normalizeSeverity(severity);
  return !KNOWN.has(value) || value === "high" || value === "critical";
}

/**
 * The advisories a comparison adds: those an `added` change carries and no
 * `removed` change in the same comparison carries. Bumping a package whose
 * advisory the base already has adds none.
 */
export function addedAdvisories(changes) {
  if (!Array.isArray(changes)) {
    throw new Error("the comparison is not a JSON array of changes");
  }
  const known = new Set();
  for (const change of changes) {
    if (change.change_type !== "removed") continue;
    for (const v of change.vulnerabilities ?? []) known.add(v.advisory_ghsa_id);
  }
  const found = [];
  for (const change of changes) {
    if (change.change_type !== "added") continue;
    for (const v of change.vulnerabilities ?? []) {
      if (known.has(v.advisory_ghsa_id)) continue;
      found.push({
        id: v.advisory_ghsa_id,
        severity: normalizeSeverity(v.severity),
        ecosystem: change.ecosystem,
        name: change.name,
        version: change.version,
        manifest: change.manifest,
        summary: v.advisory_summary,
        url: v.advisory_url,
      });
    }
  }
  return found;
}

/** The open alerts in `gh api --paginate --jq '.[]'` output: one alert per line. */
export function openAlerts(text) {
  const found = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let alert;
    try {
      alert = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1} is not a JSON alert`);
    }
    if (alert.state !== "open") continue;
    const advisory = alert.security_advisory ?? {};
    found.push({
      id: advisory.ghsa_id,
      severity: normalizeSeverity(advisory.severity),
      ecosystem: alert.dependency?.package?.ecosystem,
      name: alert.dependency?.package?.name,
      version: alert.security_vulnerability?.vulnerable_version_range,
      manifest: alert.dependency?.manifest_path,
      summary: advisory.summary,
      url: alert.html_url,
    });
  }
  return found;
}

/** Text on one line, so no part of it can start a workflow command. */
function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A workflow command's message, escaped. */
function commandData(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

/** A workflow command's property value, escaped. */
function commandProperty(value) {
  return commandData(oneLine(value))
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function describe(finding) {
  return oneLine(
    `${finding.name} ${finding.version} in ${finding.manifest}: ${finding.severity} ${finding.id} ${finding.summary ?? ""} ${finding.url ?? ""}`,
  );
}

/**
 * One line per finding, then a count. With `annotate` each line is an error or
 * warning annotation for GitHub Actions.
 */
export function report(findings, { annotate = false } = {}) {
  const lines = [];
  let broken = 0;
  for (const finding of findings) {
    const breaks = breaksPolicy(finding);
    if (breaks) broken += 1;
    const text = describe(finding);
    lines.push(
      annotate
        ? `::${breaks ? "error" : "warning"} title=${commandProperty(finding.id)}::${commandData(text)}`
        : `${breaks ? "FAIL" : "warn"} ${text}`,
    );
  }
  lines.push(
    findings.length === 0
      ? "No advisories."
      : `${findings.length} advisories, ${broken} against the policy.`,
  );
  return { lines, broken };
}

/** A Markdown table of the findings for the job summary. */
export function summaryTable(findings) {
  if (findings.length === 0) return "No new advisories.\n";
  const cell = (value) => oneLine(value).replaceAll("|", "\\|");
  const rows = findings.map(
    (f) =>
      `| ${breaksPolicy(f) ? "Fails" : "Warning"} | ${cell(f.severity)} | ${cell(`${f.name} ${f.version}`)} | ${cell(f.manifest)} | [${cell(f.id)}](${cell(f.url)}) |`,
  );
  return [
    "| Result | Severity | Package | Manifest | Advisory |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function cli(argv, env = process.env) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { changes: { type: "string" }, file: { type: "string" } },
  });
  let findings;
  if (command === "review" && values.changes) {
    findings = addedAdvisories(
      JSON.parse(fs.readFileSync(values.changes, "utf8")),
    );
  } else if (command === "alerts" && values.file) {
    findings = openAlerts(fs.readFileSync(values.file, "utf8"));
  } else {
    throw new Error(USAGE);
  }
  const { lines, broken } = report(findings, {
    annotate: env.GITHUB_ACTIONS === "true",
  });
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Dependency advisories\n\n${summaryTable(findings)}`,
    );
  }
  return { output: `${lines.join("\n")}\n`, failed: broken > 0 };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { output, failed } = cli(process.argv.slice(2));
    process.stdout.write(output);
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error(`advisories: ${err.message}`);
    process.exitCode = 1;
  }
}
