import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  checkApp,
  checkRelease,
  cli,
  entitlementKeys,
  gatekeeperEnabled,
  notarizeDmg,
  notaryAuth,
  parseNotarySubmit,
  parseSignature,
  spctlVerdict,
} from "./macos-trust.mjs";

const TEAM = "ABCDE12345";
// `codesign --display --verbose=4` of a Developer ID signed, notarized and stapled app.
const SIGNED = [
  "Executable=/Volumes/SkoposIDE/SkoposIDE.app/Contents/MacOS/skopos-app",
  "Identifier=dev.skopos.ide",
  "Format=app bundle with Mach-O thin (arm64)",
  "CodeDirectory v=20500 size=357071 flags=0x10000(runtime) hashes=11152+7 location=embedded",
  "Signature size=9046",
  "Authority=Developer ID Application: Jane Doe (ABCDE12345)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "Timestamp=23 Nov 2026 at 10:00:00",
  "Notarization Ticket=stapled",
  "Info.plist entries=21",
  "TeamIdentifier=ABCDE12345",
  "Runtime Version=15.5.0",
].join("\n");
// The same for the ad-hoc build that v0.10.0 shipped (release run 44996925467).
const ADHOC = [
  "Executable=/Volumes/SkoposIDE/SkoposIDE.app/Contents/MacOS/skopos-app",
  "Identifier=dev.skopos.ide",
  "CodeDirectory v=20500 size=357071 flags=0x10002(adhoc,runtime) hashes=11152+3 location=embedded",
  "Signature=adhoc",
  "Info.plist entries=21",
  "TeamIdentifier=not set",
  "Runtime Version=15.5.0",
].join("\n");
const NOTARIZED_APP = [
  "/tmp/m/SkoposIDE.app: accepted",
  "source=Notarized Developer ID",
  "origin=Developer ID Application: Jane Doe (ABCDE12345)",
].join("\n");
const UNNOTARIZED_APP = [
  "/tmp/m/SkoposIDE.app: rejected",
  "source=Unnotarized Developer ID",
  "origin=Developer ID Application: Jane Doe (ABCDE12345)",
].join("\n");
const SECURITY_DISABLED = "/tmp/m/SkoposIDE.app: accepted\noverride=security disabled";
const GET_TASK_ALLOW =
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
  "<key>com.apple.security.get-task-allow</key><true/></dict></plist>";
const ACCEPTED =
  '{"id":"2efe2717-52ef-43a5-96dc-0797e4ca1041","message":"Processing complete","status":"Accepted"}';

describe("notaryAuth", () => {
  const apiKey = {
    APPLE_API_KEY: "K1",
    APPLE_API_KEY_PATH: "/r/AuthKey_K1.p8",
    APPLE_API_ISSUER: "I1",
  };
  const appleId = { APPLE_ID: "jane@example.com", APPLE_PASSWORD: "pw", APPLE_TEAM_ID: TEAM };

  test("uses the App Store Connect API key when one is set", () => {
    assert.deepEqual(notaryAuth(apiKey), [
      "--key",
      "/r/AuthKey_K1.p8",
      "--key-id",
      "K1",
      "--issuer",
      "I1",
    ]);
  });

  test("prefers the API key when both methods are set", () => {
    assert.equal(notaryAuth({ ...appleId, ...apiKey })[0], "--key");
  });

  test("uses the Apple ID with its app-specific password otherwise", () => {
    assert.deepEqual(notaryAuth(appleId), [
      "--apple-id",
      "jane@example.com",
      "--password",
      "pw",
      "--team-id",
      TEAM,
    ]);
  });

  test("names the parts of a method that are missing", () => {
    assert.throws(() => notaryAuth({ APPLE_API_KEY: "K1" }), {
      message: "notarization needs APPLE_API_KEY_PATH, APPLE_API_ISSUER",
    });
    assert.throws(() => notaryAuth({ APPLE_ID: "jane@example.com", APPLE_PASSWORD: "pw" }), {
      message: "notarization needs APPLE_TEAM_ID",
    });
  });

  test("names both methods when neither is set, and treats empty values as unset", () => {
    assert.throws(() => notaryAuth({ APPLE_API_KEY: "", APPLE_ID: "" }), /APPLE_API_KEY.* or APPLE_ID/);
  });
});

describe("parseNotarySubmit", () => {
  test("reads the id and status", () => {
    assert.deepEqual(parseNotarySubmit(ACCEPTED), {
      id: "2efe2717-52ef-43a5-96dc-0797e4ca1041",
      status: "Accepted",
    });
  });

  test("finds the reply after progress lines", () => {
    const text = `Conducting pre-submission checks for x.dmg\nSubmission ID received\n${ACCEPTED}\n`;
    assert.equal(parseNotarySubmit(text).status, "Accepted");
  });

  test("reads a reply that is not Accepted", () => {
    assert.equal(parseNotarySubmit('{"id":"abc","status":"In Progress"}').status, "In Progress");
  });

  test("fails with the tool's text when there is no reply", () => {
    assert.throws(
      () => parseNotarySubmit("Error: HTTP status code: 401. Unable to authenticate.\n"),
      /no submission id and status: Error: HTTP status code: 401/,
    );
  });
});

describe("parseSignature", () => {
  test("reads a Developer ID signature", () => {
    assert.deepEqual(parseSignature(SIGNED), {
      authority: "Developer ID Application: Jane Doe (ABCDE12345)",
      team: TEAM,
      timestamp: "23 Nov 2026 at 10:00:00",
      flags: ["runtime"],
      adhoc: false,
    });
  });

  test("reads an ad-hoc signature", () => {
    assert.deepEqual(parseSignature(ADHOC), {
      authority: null,
      team: "not set",
      timestamp: null,
      flags: ["adhoc", "runtime"],
      adhoc: true,
    });
  });

  test("reads no flags and no secure timestamp", () => {
    const text = SIGNED.replace("flags=0x10000(runtime)", "flags=0x0(none)").replace(
      "Timestamp=",
      "Signed Time=",
    );
    const signature = parseSignature(text);
    assert.deepEqual(signature.flags, []);
    assert.equal(signature.timestamp, null);
  });
});

describe("entitlementKeys", () => {
  test("is empty when the app has none", () => {
    assert.deepEqual(entitlementKeys("Executable=/tmp/m/SkoposIDE.app/Contents/MacOS/skopos-app\n"), []);
  });

  test("lists each key", () => {
    assert.deepEqual(entitlementKeys(GET_TASK_ALLOW), ["com.apple.security.get-task-allow"]);
  });
});

describe("spctlVerdict", () => {
  test("reads a notarized app", () => {
    assert.deepEqual(spctlVerdict(NOTARIZED_APP), {
      accepted: true,
      source: "Notarized Developer ID",
      override: null,
    });
  });

  test("reads a rejected app", () => {
    assert.deepEqual(spctlVerdict(UNNOTARIZED_APP), {
      accepted: false,
      source: "Unnotarized Developer ID",
      override: null,
    });
  });

  test("reads an acceptance that only says Gatekeeper is off", () => {
    assert.deepEqual(spctlVerdict(SECURITY_DISABLED), {
      accepted: true,
      source: null,
      override: "security disabled",
    });
  });
});

describe("gatekeeperEnabled", () => {
  test("reads spctl --status", () => {
    assert.equal(gatekeeperEnabled("assessments enabled\n"), true);
    assert.equal(gatekeeperEnabled("assessments disabled\n"), false);
    assert.equal(gatekeeperEnabled(""), false);
  });
});

const NOT_STAPLED =
  "Processing: /tmp/m/SkoposIDE.app\nSkoposIDE.app does not have a ticket stapled to it.";
const DMG = "SkoposIDE_0.12.0_aarch64.dmg";
const ARCHIVE = "SkoposIDE_aarch64.app.tar.gz";
const API_ENV = {
  APPLE_API_KEY: "K1",
  APPLE_API_KEY_PATH: "/r/AuthKey_K1.p8",
  APPLE_API_ISSUER: "issuer-secret",
};
const ok = (stdout = "", stderr = "") => ({ status: 0, stdout, stderr });
const fail = (status, stdout = "", stderr = "") => ({ status, stdout, stderr });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "macos-trust-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * A fake runner. Each rule is [text the command line includes, reply or reply function]; the
 * first match wins. A command no rule matches answers as a good, notarized release would.
 */
function fakeRun(rules = []) {
  const calls = [];
  const good = [
    ["spctl --status", ok("assessments enabled\n")],
    ["codesign --display --verbose=4", ok("", SIGNED)],
    ["codesign --display --entitlements", ok("", "Executable=/tmp/m/SkoposIDE.app/Contents/MacOS/skopos-app\n")],
    ["spctl --assess", ok("", NOTARIZED_APP)],
    ["notarytool submit", ok(ACCEPTED)],
  ];
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const rule = [...rules, ...good].find(([text]) => line.includes(text));
    if (rule === undefined) return ok();
    return typeof rule[1] === "function" ? rule[1](line) : rule[1];
  };
  return { run, calls };
}

const failing = (results, prefix = "app: ") =>
  results.filter((result) => !result.ok).map((result) => result.name.replace(prefix, ""));

describe("checkApp", () => {
  test("passes a Developer ID signed, notarized, stapled app", () => {
    const { run } = fakeRun();
    const results = checkApp(run, "/m/SkoposIDE.app", TEAM, "app");
    assert.equal(results.length, 8);
    assert.deepEqual(failing(results), []);
  });

  const cases = [
    [
      "an ad-hoc signature",
      [["codesign --display --verbose=4", ok("", ADHOC)]],
      ["signed with Developer ID Application", `team ${TEAM}`, "secure timestamp"],
    ],
    [
      "another team",
      [["codesign --display --verbose=4", ok("", SIGNED.replace("TeamIdentifier=ABCDE12345", "TeamIdentifier=ZZZZZ99999"))]],
      [`team ${TEAM}`],
    ],
    [
      "no hardened runtime",
      [["codesign --display --verbose=4", ok("", SIGNED.replace("flags=0x10000(runtime)", "flags=0x0(none)"))]],
      ["hardened runtime"],
    ],
    [
      "no secure timestamp",
      [["codesign --display --verbose=4", ok("", SIGNED.replace("Timestamp=", "Signed Time="))]],
      ["secure timestamp"],
    ],
    [
      "an entitlement",
      [["codesign --display --entitlements", ok(GET_TASK_ALLOW)]],
      ["no entitlements"],
    ],
    ["no stapled ticket", [["stapler validate", fail(65, NOT_STAPLED)]], ["stapled ticket"]],
    [
      "an app Gatekeeper rejects",
      [["spctl --assess", fail(3, "", UNNOTARIZED_APP)]],
      ["Gatekeeper: Notarized Developer ID"],
    ],
    [
      "Gatekeeper off",
      [["spctl --assess", ok("", SECURITY_DISABLED)]],
      ["Gatekeeper: Notarized Developer ID"],
    ],
    [
      "a broken seal",
      [["codesign --verify", fail(1, "", "a sealed resource is missing or invalid")]],
      ["codesign verifies the signature"],
    ],
  ];
  for (const [title, rules, expected] of cases) {
    test(`fails only the matching checks for ${title}`, () => {
      const { run } = fakeRun(rules);
      assert.deepEqual(failing(checkApp(run, "/m/SkoposIDE.app", TEAM, "app")), expected);
    });
  }

  test("asks spctl to assess the app for execution", () => {
    const { run, calls } = fakeRun();
    checkApp(run, "/m/SkoposIDE.app", TEAM, "app");
    assert.ok(calls.includes("spctl --assess --type execute --verbose=2 /m/SkoposIDE.app"));
  });
});

describe("checkRelease", () => {
  const options = { dmg: DMG, updater: ARCHIVE, team: TEAM, tmp };

  test("passes a good release and checks both copies of the app", () => {
    const { run, calls } = fakeRun();
    const results = checkRelease(run, options);
    assert.deepEqual(failing(results, ""), []);
    assert.ok(calls.includes(`codesign --verify --strict --verbose=2 ${DMG}`));
    assert.ok(calls.includes(`xcrun stapler validate ${DMG}`));
    assert.ok(
      calls.includes(
        `spctl --assess --type open --context context:primary-signature --verbose=2 ${DMG}`,
      ),
    );
    assert.ok(calls.some((call) => call.startsWith(`hdiutil attach ${DMG} -nobrowse -readonly -mountpoint `)));
    assert.ok(calls.some((call) => call.startsWith("hdiutil detach ")));
    assert.ok(calls.some((call) => call.startsWith(`tar -xzf ${ARCHIVE} -C `)));
    assert.equal(calls.filter((call) => call.startsWith("codesign --display --verbose=4")).length, 2);
    assert.ok(results.some((result) => result.name.startsWith(`SkoposIDE.app in ${DMG}: `)));
    assert.ok(results.some((result) => result.name.startsWith(`SkoposIDE.app in ${ARCHIVE}: `)));
  });

  test("turns Gatekeeper assessments on when the runner has them off", () => {
    let statusCalls = 0;
    const { run, calls } = fakeRun([
      [
        "spctl --status",
        () => ok(++statusCalls === 1 ? "assessments disabled\n" : "assessments enabled\n"),
      ],
    ]);
    const results = checkRelease(run, options);
    assert.ok(calls.includes("sudo spctl --master-enable"));
    assert.equal(results[0].name, "Gatekeeper assessments are enabled");
    assert.equal(results[0].ok, true);
  });

  test("fails when Gatekeeper assessments stay off", () => {
    const { run } = fakeRun([["spctl --status", ok("assessments disabled\n")]]);
    const [first] = checkRelease(run, options);
    assert.equal(first.name, "Gatekeeper assessments are enabled");
    assert.equal(first.ok, false);
  });

  test("reports a dmg that does not mount and still checks the updater archive", () => {
    const { run, calls } = fakeRun([
      ["hdiutil attach", fail(1, "", "hdiutil: attach failed - image not recognized")],
    ]);
    const results = checkRelease(run, options);
    assert.deepEqual(failing(results, ""), [`${DMG}: mounts`]);
    assert.ok(!calls.some((call) => call.startsWith("hdiutil detach")));
    assert.equal(results.filter((result) => result.name.includes(`in ${ARCHIVE}: `)).length, 8);
  });

  test("detaches the dmg even when the app inside fails", () => {
    const { run, calls } = fakeRun([["codesign --verify --deep", fail(1, "", "invalid")]]);
    checkRelease(run, options);
    assert.ok(calls.some((call) => call.startsWith("hdiutil detach ")));
  });

  test("reports an updater archive that does not extract", () => {
    const { run } = fakeRun([["tar -xzf", fail(2, "", "tar: Error opening archive")]]);
    const results = checkRelease(run, options);
    assert.deepEqual(failing(results, ""), [`${ARCHIVE}: extracts`]);
    assert.ok(!results.some((result) => result.name.includes(`in ${ARCHIVE}: `)));
  });
});

describe("notarizeDmg", () => {
  test("submits the dmg, waits for Apple, then staples it", () => {
    const { run, calls } = fakeRun();
    const lines = [];
    notarizeDmg(run, DMG, API_ENV, (line) => lines.push(line));
    assert.deepEqual(calls, [
      `xcrun notarytool submit ${DMG} --key /r/AuthKey_K1.p8 --key-id K1 --issuer issuer-secret` +
        " --wait --timeout 40m --output-format json",
      `xcrun stapler staple ${DMG}`,
    ]);
    assert.match(lines.join("\n"), /Accepted/);
    assert.match(lines.join("\n"), /ticket stapled/);
  });

  test("never logs a credential", () => {
    const { run } = fakeRun([
      ["notarytool submit", fail(1, '{"id":"abc","status":"Invalid"}')],
      ["notarytool log", ok('{"issues":[{"message":"The binary is not signed."}]}')],
    ]);
    const lines = [];
    const env = { APPLE_ID: "jane@example.com", APPLE_PASSWORD: "app-specific-secret", APPLE_TEAM_ID: TEAM };
    assert.throws(() => notarizeDmg(run, DMG, env, (line) => lines.push(line)));
    assert.doesNotMatch(lines.join("\n"), /app-specific-secret/);
  });

  test("prints Apple's log and does not staple a rejected dmg", () => {
    const { run, calls } = fakeRun([
      ["notarytool submit", fail(1, '{"id":"abc","status":"Invalid","message":"Processing complete"}')],
      ["notarytool log", ok('{"issues":[{"message":"The binary is not signed."}]}')],
    ]);
    const lines = [];
    assert.throws(() => notarizeDmg(run, DMG, API_ENV, (line) => lines.push(line)), {
      message: `Apple did not accept ${DMG}: Invalid`,
    });
    assert.ok(calls.some((call) => call.startsWith("xcrun notarytool log abc --key ")));
    assert.ok(!calls.some((call) => call.startsWith("xcrun stapler")));
    assert.match(lines.join("\n"), /The binary is not signed\./);
  });

  test("treats a wait that timed out as not accepted", () => {
    const { run, calls } = fakeRun([
      ["notarytool submit", fail(1, '{"id":"abc","status":"In Progress"}')],
    ]);
    assert.throws(() => notarizeDmg(run, DMG, API_ENV, () => {}), /In Progress/);
    assert.ok(!calls.some((call) => call.startsWith("xcrun stapler")));
  });

  test("fails when stapling fails", () => {
    const { run } = fakeRun([["stapler staple", fail(65, "", "Could not validate ticket")]]);
    assert.throws(() => notarizeDmg(run, DMG, API_ENV, () => {}), /stapler could not staple/);
  });

  test("runs nothing without credentials", () => {
    const { run, calls } = fakeRun();
    assert.throws(() => notarizeDmg(run, DMG, {}, () => {}), /notarization needs/);
    assert.deepEqual(calls, []);
  });
});

describe("cli", () => {
  const quiet = { log: () => {}, tmp };

  test("rejects an unknown command, a missing option and a second dmg", () => {
    const { run } = fakeRun();
    for (const argv of [
      ["sign", "--dmg", DMG],
      ["check", "--dmg", DMG, "--updater", ARCHIVE],
      ["check", "--dmg", DMG, "other.dmg", "--updater", ARCHIVE, "--team", TEAM],
    ]) {
      assert.throws(() => cli(argv, { ...quiet, run }), /usage: node scripts\/macos-trust\.mjs/);
    }
  });

  test("prints one ok line per check for a good release", () => {
    const { run } = fakeRun();
    const lines = [];
    cli(["check", "--dmg", DMG, "--updater", ARCHIVE, "--team", TEAM], {
      run,
      tmp,
      log: (line) => lines.push(line),
    });
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.startsWith("ok   ")));
  });

  test("prints FAIL with the tool's output and fails the run", () => {
    const { run } = fakeRun([["stapler validate", fail(65, NOT_STAPLED)]]);
    const lines = [];
    assert.throws(
      () =>
        cli(["check", "--dmg", DMG, "--updater", ARCHIVE, "--team", TEAM], {
          run,
          tmp,
          log: (line) => lines.push(line),
        }),
      /^Error: 3 of \d+ checks failed$/,
    );
    assert.ok(lines.includes(`FAIL ${DMG}: stapled ticket`));
    assert.ok(lines.some((line) => line.includes("does not have a ticket stapled")));
  });

  test("notarizes with the environment it is given", () => {
    const { run, calls } = fakeRun();
    cli(["notarize", "--dmg", DMG], { ...quiet, run, env: API_ENV });
    assert.ok(calls.includes(`xcrun stapler staple ${DMG}`));
  });
});
