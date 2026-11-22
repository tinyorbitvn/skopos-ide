// Notarizes and staples a release dmg, and checks that the macOS release files are signed with
// Developer ID, notarized by Apple and stapled (macOS release trust spec §4.3). The build job of
// release.yml runs it on the macOS legs; `check` also works on a downloaded release on a Mac.

export const APP = "SkoposIDE.app";
export const NOTARIZED = "Notarized Developer ID";
export const NOTARY_TIMEOUT = "40m";

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
