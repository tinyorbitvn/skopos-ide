import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  entitlementKeys,
  gatekeeperEnabled,
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
