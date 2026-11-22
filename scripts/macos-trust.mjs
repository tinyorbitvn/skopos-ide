// Notarizes and staples a release dmg, and checks that the macOS release files are signed with
// Developer ID, notarized by Apple and stapled (macOS release trust spec §4.3). The build job of
// release.yml runs it on the macOS legs; `check` also works on a downloaded release on a Mac.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const APP = "SkoposIDE.app";
export const NOTARIZED = "Notarized Developer ID";
export const NOTARY_TIMEOUT = "40m";
const STAPLE_ATTEMPTS = 3;
const STAPLE_WAIT_SECONDS = 20;
const USAGE = [
  "usage: node scripts/macos-trust.mjs notarize --dmg <file>",
  "       node scripts/macos-trust.mjs check --dmg <file> --updater <app.tar.gz> --team <team id>",
].join("\n");

/** notarytool's credential flags, from the variables the release workflow exports. */
export function notaryAuth(env) {
  const need = (names) => {
    const missing = names.filter((name) => !env[name]);
    if (missing.length > 0) throw new Error(`notarization needs ${missing.join(", ")}`);
  };
  if (env.APPLE_API_KEY) {
    need(["APPLE_API_KEY_PATH", "APPLE_API_ISSUER"]);
    return [
      "--key",
      env.APPLE_API_KEY_PATH,
      "--key-id",
      env.APPLE_API_KEY,
      "--issuer",
      env.APPLE_API_ISSUER,
    ];
  }
  if (env.APPLE_ID) {
    need(["APPLE_PASSWORD", "APPLE_TEAM_ID"]);
    return [
      "--apple-id",
      env.APPLE_ID,
      "--password",
      env.APPLE_PASSWORD,
      "--team-id",
      env.APPLE_TEAM_ID,
    ];
  }
  throw new Error(
    "notarization needs APPLE_API_KEY, APPLE_API_KEY_PATH and APPLE_API_ISSUER," +
      " or APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID",
  );
}

/** The submission id and status from `notarytool submit --output-format json`. */
export function parseNotarySubmit(text) {
  for (const candidate of [text, ...text.split("\n").reverse()]) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try {
      const reply = JSON.parse(candidate.slice(start, end + 1));
      if (typeof reply.id === "string" && typeof reply.status === "string") {
        return { id: reply.id, status: reply.status };
      }
    } catch {
      // Progress text or a partial line: try the next candidate.
    }
  }
  throw new Error(`notarytool gave no submission id and status: ${text.trim()}`);
}

/** What `codesign --display --verbose=4` says about a signature. */
export function parseSignature(text) {
  const lines = text.split(/\r?\n/);
  const value = (key) => {
    const line = lines.find((candidate) => candidate.startsWith(`${key}=`));
    return line === undefined ? null : line.slice(key.length + 1).trim();
  };
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(text);
  return {
    authority: value("Authority"),
    team: value("TeamIdentifier"),
    timestamp: value("Timestamp"),
    flags: flags ? flags[1].split(",").filter((flag) => flag !== "" && flag !== "none") : [],
    adhoc: value("Signature") === "adhoc",
  };
}

/** The keys of the plist that `codesign --display --entitlements - --xml` prints. */
export function entitlementKeys(xml) {
  return [...xml.matchAll(/<key>([^<]*)<\/key>/g)].map((match) => match[1]);
}

/** `spctl --assess` output: whether it was accepted, its source, and any override. */
export function spctlVerdict(text) {
  return {
    accepted: /: accepted$/m.test(text),
    source: /^source=(.*)$/m.exec(text)?.[1].trim() ?? null,
    override: /^override=(.*)$/m.exec(text)?.[1].trim() ?? null,
  };
}

/** Whether `spctl --status` says Gatekeeper assessments are on. */
export function gatekeeperEnabled(text) {
  return /^assessments enabled$/m.test(text);
}

/** Runs a tool and returns its exit status and output; a missing tool is status 127. */
export function systemRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { status: 127, stdout: "", stderr: result.error.message };
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const output = (result) => `${result.stdout}${result.stderr}`.trim();

/** Whether spctl accepts the file as notarized, not just because Gatekeeper is off. */
function gatekeeperAccepts(run, type, file, extra = []) {
  const result = run("spctl", ["--assess", "--type", type, ...extra, "--verbose=2", file]);
  const verdict = spctlVerdict(output(result));
  const ok =
    result.status === 0 &&
    verdict.accepted &&
    verdict.source === NOTARIZED &&
    verdict.override === null;
  return { ok, detail: output(result) };
}

/** Adds the Developer ID and team checks every signed file gets, and returns its signature. */
function checkSigner(run, file, team, add) {
  const display = run("codesign", ["--display", "--verbose=4", file]);
  const shown = output(display);
  const signature = parseSignature(shown);
  const developerId =
    display.status === 0 &&
    !signature.adhoc &&
    (signature.authority ?? "").startsWith("Developer ID Application:");
  add("signed with Developer ID Application", developerId, shown);
  add(`team ${team}`, signature.team === team, shown);
  return { signature, shown };
}

/** Checks one copy of the app; `label` starts each result's name. */
export function checkApp(run, app, team, label) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name: `${label}: ${name}`, ok, detail });
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  add("codesign verifies the signature", verify.status === 0, output(verify));
  const { signature, shown } = checkSigner(run, app, team, add);
  add("hardened runtime", signature.flags.includes("runtime"), shown);
  add("secure timestamp", signature.timestamp !== null, shown);
  const entitlements = run("codesign", ["--display", "--entitlements", "-", "--xml", app]);
  const keys = entitlementKeys(output(entitlements));
  add(
    "no entitlements",
    entitlements.status === 0 && keys.length === 0,
    keys.join(", ") || output(entitlements),
  );
  const staple = run("xcrun", ["stapler", "validate", app]);
  add("stapled ticket", staple.status === 0, output(staple));
  const gatekeeper = gatekeeperAccepts(run, "execute", app);
  add(`Gatekeeper: ${NOTARIZED}`, gatekeeper.ok, gatekeeper.detail);
  return results;
}

/**
 * Gatekeeper must be on for spctl to prove anything. On CI the check turns it on when the runner
 * has it off; on a person's Mac it never changes the setting, and says how to.
 */
export function ensureGatekeeper(run, ci) {
  const name = "Gatekeeper assessments are enabled";
  const before = output(run("spctl", ["--status"]));
  if (gatekeeperEnabled(before)) return { name, ok: true, detail: "" };
  if (!ci) {
    const how = "This check leaves the setting alone. To check here, run: sudo spctl --master-enable";
    return { name, ok: false, detail: `${before}\n${how}`.trim() };
  }
  const enable = run("sudo", ["spctl", "--master-enable"]);
  const status = output(run("spctl", ["--status"]));
  return { name, ok: gatekeeperEnabled(status), detail: `${output(enable)}\n${status}`.trim() };
}

/** Checks the dmg itself, then the app inside it. */
export function checkDmg(run, dmg, team, tmp) {
  const label = path.basename(dmg);
  const results = [];
  const add = (name, ok, detail) => results.push({ name: `${label}: ${name}`, ok, detail });
  const verify = run("codesign", ["--verify", "--strict", "--verbose=2", dmg]);
  add("codesign verifies the signature", verify.status === 0, output(verify));
  checkSigner(run, dmg, team, add);
  const staple = run("xcrun", ["stapler", "validate", dmg]);
  add("stapled ticket", staple.status === 0, output(staple));
  const gatekeeper = gatekeeperAccepts(run, "open", dmg, [
    "--context",
    "context:primary-signature",
  ]);
  add(`Gatekeeper: ${NOTARIZED}`, gatekeeper.ok, gatekeeper.detail);
  const mount = fs.mkdtempSync(path.join(tmp, "dmg-"));
  const attach = run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
  add("mounts", attach.status === 0, output(attach));
  if (attach.status !== 0) {
    removeEmptyFolder(mount);
    return results;
  }
  try {
    results.push(...checkApp(run, path.join(mount, APP), team, `${APP} in ${label}`));
  } finally {
    if (run("hdiutil", ["detach", mount]).status !== 0) {
      run("hdiutil", ["detach", "-force", mount]);
    }
    removeEmptyFolder(mount);
  }
  return results;
}

/** Removes a folder only when it is empty: one that is still a mount point keeps its files. */
function removeEmptyFolder(dir) {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Still mounted or not empty; leaving it is the safe outcome.
  }
}

/** Checks the app the updater installs, from its archive. */
export function checkUpdater(run, archive, team, tmp) {
  const label = path.basename(archive);
  const dir = fs.mkdtempSync(path.join(tmp, "updater-"));
  try {
    const extract = run("tar", ["-xzf", archive, "-C", dir]);
    const extracted = { name: `${label}: extracts`, ok: extract.status === 0, detail: output(extract) };
    if (!extracted.ok) return [extracted];
    return [extracted, ...checkApp(run, path.join(dir, APP), team, `${APP} in ${label}`)];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every check of spec §4.3, in the order the log prints them. */
export function checkRelease(run, { dmg, updater, team, tmp, ci = false }) {
  return [
    ensureGatekeeper(run, ci),
    ...checkDmg(run, dmg, team, tmp),
    ...checkUpdater(run, updater, team, tmp),
  ];
}

/** Notarizes the dmg Tauri signed and staples the ticket to it; Tauri does neither. */
export function notarizeDmg(run, dmg, env, log) {
  const auth = notaryAuth(env);
  const name = path.basename(dmg);
  const submit = run("xcrun", [
    "notarytool",
    "submit",
    dmg,
    ...auth,
    "--wait",
    "--timeout",
    NOTARY_TIMEOUT,
    "--output-format",
    "json",
  ]);
  const { id, status } = parseNotarySubmit(output(submit));
  log(`${name}: notarization ${id} ${status}`);
  if (status !== "Accepted") {
    log(output(run("xcrun", ["notarytool", "log", id, ...auth])));
    throw new Error(`Apple did not accept ${name}: ${status}`);
  }
  // Right after Accepted, the ticket may not have reached Apple's ticket service yet.
  for (let attempt = 1; ; attempt++) {
    const staple = run("xcrun", ["stapler", "staple", dmg]);
    if (staple.status === 0) break;
    if (attempt === STAPLE_ATTEMPTS) {
      throw new Error(`stapler could not staple ${name}: ${output(staple)}`);
    }
    log(`${name}: stapler failed, trying again in ${STAPLE_WAIT_SECONDS}s: ${output(staple)}`);
    run("sleep", [String(STAPLE_WAIT_SECONDS)]);
  }
  log(`${name}: ticket stapled`);
}

export function cli(
  argv,
  { run = systemRun, env = process.env, log = console.log, tmp = os.tmpdir() } = {},
) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        dmg: { type: "string" },
        updater: { type: "string" },
        team: { type: "string" },
      },
    }));
  } catch (error) {
    throw new Error(`${error.message}\n${USAGE}`);
  }
  if (command === "notarize" && values.dmg) {
    notarizeDmg(run, values.dmg, env, log);
    return;
  }
  if (command === "check" && values.dmg && values.updater && values.team) {
    const results = checkRelease(run, {
      dmg: values.dmg,
      updater: values.updater,
      team: values.team,
      tmp,
      ci: env.GITHUB_ACTIONS === "true",
    });
    for (const result of results) {
      log(`${result.ok ? "ok  " : "FAIL"} ${result.name}`);
      if (!result.ok && result.detail) log(result.detail.replace(/^/gm, "     "));
    }
    const failed = results.filter((result) => !result.ok).length;
    if (failed > 0) throw new Error(`${failed} of ${results.length} checks failed`);
    return;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli(process.argv.slice(2));
  } catch (err) {
    console.error(`macos-trust: ${err.message}`);
    process.exitCode = 1;
  }
}
