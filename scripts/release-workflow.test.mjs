import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const release = read(".github", "workflows", "release.yml");

/** One job's text, from its key to the next job's key. */
function job(name) {
  const start = release.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no job ${name}`);
  const rest = release.slice(start + 1);
  const next = rest.search(/\n {2}[a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Asserts the parts appear in this order. */
function inOrder(text, parts) {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    assert.ok(at >= 0, `${part} is missing or out of order`);
    from = at + part.length;
  }
}

/** One step's text in a job's text, from its `- name:` line to the next step. */
function step(jobText, name) {
  const start = jobText.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `no step ${name}`);
  const rest = jobText.slice(start + 1);
  const next = rest.search(/\n {6}- /);
  return next < 0 ? rest : rest.slice(0, next);
}

test("only the release build makes updater files, through an extra configuration", () => {
  assert.deepEqual(JSON.parse(read("crates", "skopos-app", "tauri.updater.conf.json")), {
    bundle: { createUpdaterArtifacts: true },
  });
  const build = job("build");
  assert.match(
    build,
    /^ {10}args: \$\{\{ matrix\.args \}\} --config crates\/skopos-app\/tauri\.conf\.json --config crates\/skopos-app\/tauri\.updater\.conf\.json$/m,
  );
  assert.match(build, /^ {10}includeUpdaterJson: false$/m);
  assert.doesNotMatch(build, /uploadUpdaterJson/);
});

test("the bundle targets include the macOS app, which the updater archive is made from", () => {
  const { targets } = JSON.parse(read("crates", "skopos-app", "tauri.conf.json")).bundle;
  assert.ok(targets.includes("app"), `bundle.targets ${JSON.stringify(targets)} leaves out "app"`);
  assert.ok(targets.includes("dmg"));
});

test("the build signs with the repository secrets, after checking the key is set", () => {
  const build = job("build");
  assert.match(
    build,
    /^ {10}TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}$/m,
  );
  assert.match(
    build,
    /^ {10}TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}$/m,
  );
  inOrder(build, ["secrets.TAURI_SIGNING_PRIVATE_KEY != ''", "uses: tauri-apps/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5"]);
});

test("publish builds latest.json, uploads it to the draft, checks the draft, publishes, then checks the link", () => {
  inOrder(job("publish"), [
    "uses: actions/checkout@v4",
    "node scripts/updater-manifest.mjs build",
    'gh release upload "$GITHUB_REF_NAME" "$dir/latest.json" --clobber',
    "for suffix in",
    'for name in "${updater[@]}"; do',
    "-F draft=false",
    "if: needs.verify.outputs.prerelease != 'true'",
    "releases/latest/download/latest.json",
    "node scripts/updater-manifest.mjs urls",
  ]);
});

test("the draft must hold every updater file and latest.json before it is published", () => {
  const publish = job("publish");
  for (const name of [
    '"SkoposIDE_${version}_amd64.AppImage.sig"',
    '"SkoposIDE_${version}_amd64.deb.sig"',
    'rpm="SkoposIDE-${version}-1.x86_64.rpm"',
    '"${rpm}.sig"',
    '"SkoposIDE_${version}_x64-setup.exe.sig"',
    '"SkoposIDE_aarch64.app.tar.gz"',
    '"SkoposIDE_aarch64.app.tar.gz.sig"',
    '"SkoposIDE_x64.app.tar.gz"',
    '"SkoposIDE_x64.app.tar.gz.sig"',
    '"latest.json"',
    '"SkoposIDE_${version}.cdx.json"',
  ]) {
    assert.ok(publish.includes(name), name);
  }
});

test("the Linux build installs its rpm on Fedora and AlmaLinux after building it", () => {
  const build = job("build");
  inOrder(build, [
    "uses: tauri-apps/tauri-action@",
    "- name: Install the rpm on Fedora and AlmaLinux",
    "if: runner.os == 'Linux'",
    "run: scripts/check-rpm.sh target/release/bundle/rpm/*.rpm",
  ]);
  const script = fs.readFileSync(path.join(ROOT, "scripts", "check-rpm.sh"), "utf8");
  assert.match(script, /^FEDORA_IMAGE="\$\{FEDORA_IMAGE:-fedora:\d+\}"$/m);
  assert.match(script, /^EL_IMAGE="\$\{EL_IMAGE:-almalinux:10\}"$/m);
  assert.ok(script.includes("dnf install -y -q epel-release"));
});

test("the release uploads the SBOM to the draft, and publish waits for it", () => {
  const sbom = job("sbom");
  assert.match(sbom, /^ {4}needs: draft$/m);
  assert.match(sbom, /^ {6}contents: write$/m);
  inOrder(sbom, [
    "run: make sbom",
    'name="SkoposIDE_${GITHUB_REF_NAME#v}.cdx.json"',
    'gh release upload "$GITHUB_REF_NAME" "$RUNNER_TEMP/$name" --clobber',
  ]);
  assert.match(job("publish"), /^ {4}needs: \[verify, draft, build, sbom\]$/m);
});

test("the build job uses the release environment and leaves time for notarization", () => {
  const build = job("build");
  assert.match(build, /^ {4}environment: release$/m);
  assert.match(build, /^ {4}timeout-minutes: 90$/m);
});

test("only the macOS legs get the Apple secrets, from one step before tauri-action", () => {
  const build = job("build");
  const apple = step(build, "The Apple signing secrets are set");
  assert.match(apple, /^ {8}if: runner\.os == 'macOS'$/m);
  for (const name of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_PRIVATE_KEY",
    "APPLE_ID",
    "APPLE_PASSWORD",
  ]) {
    assert.ok(apple.includes(`\${{ secrets.${name} }}`), name);
  }
  assert.ok(apple.includes("${{ vars.APPLE_TEAM_ID }}"));
  assert.ok(apple.includes("${{ vars.APPLE_SIGNING_IDENTITY }}"));
  const elsewhere = release.replace(apple, "");
  assert.doesNotMatch(elsewhere, /secrets\.APPLE_|vars\.APPLE_/);
  inOrder(build, [
    "name: The Apple signing secrets are set",
    "uses: tauri-apps/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5",
  ]);
});

test("the Apple secrets step exports values safely and only the notarization method in use", () => {
  const apple = step(job("build"), "The Apple signing secrets are set");
  // A random delimiter keeps a value with newlines or << from breaking $GITHUB_ENV.
  assert.ok(apple.includes('delimiter="EOF_$(openssl rand -hex 16)"'));
  assert.ok(apple.includes(`printf '%s<<%s\\n%s\\n%s\\n' "$1" "$delimiter" "$2" "$delimiter" >> "$GITHUB_ENV"`));
  // A pasted .p12 may hold line breaks; the stripped value is masked too.
  assert.ok(apple.includes(`certificate="$(printf '%s' "$CERTIFICATE" | tr -d '[:space:]')"`));
  assert.ok(apple.includes('echo "::add-mask::$certificate"'));
  assert.ok(apple.includes("(umask 077 && printf '%s\\n' \"$API_PRIVATE_KEY\" > \"$key_path\")"));
  inOrder(apple, [
    'if [ -n "$API_KEY" ]; then',
    "put APPLE_API_KEY_PATH",
    "else",
    "put APPLE_ID",
    "put APPLE_PASSWORD",
    "fi",
  ]);
  assert.match(apple, /::error::the release environment \$problem; see docs\/releasing\.md/);
});

test("after tauri-action the macOS legs notarize the dmg, check every file, then replace the dmg", () => {
  const build = job("build");
  inOrder(build, [
    "uses: tauri-apps/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5",
    "name: Notarize and staple the dmg",
    "node scripts/macos-trust.mjs notarize --dmg target/${{ matrix.rust-targets }}/release/bundle/dmg/*.dmg",
    "name: Check the macOS files",
    "node scripts/macos-trust.mjs check",
    "--updater target/${{ matrix.rust-targets }}/release/bundle/macos/SkoposIDE.app.tar.gz",
    '--team "$APPLE_TEAM_ID"',
    "name: Replace the dmg in the draft",
    'gh release upload "$GITHUB_REF_NAME" target/${{ matrix.rust-targets }}/release/bundle/dmg/*.dmg --clobber',
  ]);
  for (const name of [
    "Notarize and staple the dmg",
    "Check the macOS files",
    "Replace the dmg in the draft",
  ]) {
    assert.match(step(build, name), /^ {8}if: runner\.os == 'macOS'$/m, name);
  }
  assert.match(step(build, "Notarize and staple the dmg"), /^ {8}timeout-minutes: 45$/m);
  assert.doesNotMatch(build, /Verify the macOS signature/);
});

test("local, CI and e2e builds stay ad-hoc signed, with no entitlements", () => {
  const { macOS } = JSON.parse(read("crates", "skopos-app", "tauri.conf.json")).bundle;
  assert.deepEqual(macOS, { signingIdentity: "-" });
});

test("the last build step deletes the .p8 and empties every Apple secret, even after a failure", () => {
  const build = job("build");
  const exported = [
    ...step(build, "The Apple signing secrets are set").matchAll(/^ +put (APPLE_[A-Z_]+) /gm),
  ].map((match) => match[1]);
  const variables = ["APPLE_SIGNING_IDENTITY", "APPLE_TEAM_ID"];
  const secrets = exported.filter((name) => !variables.includes(name));
  assert.equal(secrets.length, 7);
  const scrub = step(build, "Remove the Apple secrets from the job");
  assert.ok(build.trimEnd().endsWith(scrub.trimEnd()), "it is the build job's last step");
  assert.match(scrub, /^ {8}if: always\(\) && runner\.os == 'macOS'$/m);
  assert.match(scrub, /rm -f -- "\$APPLE_API_KEY_PATH"/);
  for (const name of secrets) {
    assert.match(scrub, new RegExp(`^ +echo "${name}="$`, "m"), `${name} is not emptied`);
  }
  assert.ok(!scrub.includes("secrets."));
});

/** A step's `run: |` block, without its indent. */
function runBlock(stepText) {
  const lines = stepText.split("\n");
  const start = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  assert.ok(start >= 0, "no run block");
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

/** Reads a $GITHUB_ENV file as the runner does: `NAME=value` lines and `NAME<<DELIMITER` blocks. */
function parseGithubEnv(text) {
  const values = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "") continue;
    const block = line.match(/^([A-Z_]+)<<(.+)$/);
    if (block) {
      const end = lines.indexOf(block[2], index + 1);
      assert.ok(end > index, `no closing delimiter for ${block[1]}`);
      values[block[1]] = lines.slice(index + 1, end).join("\n");
      index = end;
    } else {
      const at = line.indexOf("=");
      values[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  return values;
}

// The release steps run on macOS only; Windows paths would need translating for Git Bash.
const noBash =
  (process.platform === "win32" || spawnSync("bash", ["-c", "command -v openssl"]).status !== 0) &&
  "needs bash and openssl on a POSIX system";

/** Runs one step's script as the runner would, with a fresh $GITHUB_ENV and $RUNNER_TEMP. */
function runStep(name, env, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-step-"));
  try {
    const githubEnv = path.join(dir, "github-env");
    fs.writeFileSync(githubEnv, "");
    prepare(dir);
    const script = runBlock(step(job("build"), name));
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      env: { PATH: process.env.PATH, GITHUB_ENV: githubEnv, RUNNER_TEMP: dir, ...env(dir) },
      encoding: "utf8",
    });
    const exported = parseGithubEnv(fs.readFileSync(githubEnv, "utf8"));
    const keyPath = exported.APPLE_API_KEY_PATH;
    const key = keyPath ? fs.readFileSync(keyPath, "utf8") : undefined;
    const keyMode = keyPath ? fs.statSync(keyPath).mode & 0o777 : undefined;
    return { ...result, exported, key, keyMode, files: fs.readdirSync(dir) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----";
const SECRETS = {
  CERTIFICATE: "QUJD\nREVG\r\n",
  CERTIFICATE_PASSWORD: "pa<<EOF\nss",
  TEAM_ID: "ABCDE12345",
  SIGNING_IDENTITY: "Developer ID Application: Example (ABCDE12345)",
  API_KEY: "K1",
  API_ISSUER: "issuer",
  API_PRIVATE_KEY: PRIVATE_KEY,
};
const secretsStep = (values) => runStep("The Apple signing secrets are set", () => values);

test("the Apple secrets step strips and masks the certificate and keeps odd values intact", { skip: noBash }, () => {
  const result = secretsStep(SECRETS);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^::add-mask::QUJDREVG$/m);
  assert.deepEqual(result.exported, {
    APPLE_CERTIFICATE: "QUJDREVG",
    APPLE_CERTIFICATE_PASSWORD: "pa<<EOF\nss",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (ABCDE12345)",
    APPLE_TEAM_ID: "ABCDE12345",
    APPLE_API_KEY: "K1",
    APPLE_API_ISSUER: "issuer",
    APPLE_API_KEY_PATH: result.exported.APPLE_API_KEY_PATH,
  });
  assert.match(result.exported.APPLE_API_KEY_PATH, /AuthKey_K1\.p8$/);
  assert.equal(result.key, `${PRIVATE_KEY}\n`);
  assert.equal(result.keyMode, 0o600);
});

test("the Apple secrets step refuses a certificate that is only whitespace", { skip: noBash }, () => {
  const result = secretsStep({ ...SECRETS, CERTIFICATE: " \n\r\n" });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^::error::the release environment lacks the secret APPLE_CERTIFICATE; see docs\/releasing\.md$/m,
  );
  assert.deepEqual(result.exported, {});
});

test("the Apple secrets step refuses a Team ID that is not 10 letters and digits", { skip: noBash }, () => {
  for (const team of ["ABCDE12345 ", "", "abcde12345"]) {
    const result = secretsStep({ ...SECRETS, TEAM_ID: team });
    assert.equal(result.status, 1, JSON.stringify(team));
    assert.match(result.stdout, /^::error::the release environment needs the variable APPLE_TEAM_ID set to the 10-character Team ID; see docs\/releasing\.md$/m);
    assert.deepEqual(result.exported, {});
  }
});

test("the scrub step deletes the .p8 and empties the Apple values", { skip: noBash }, () => {
  const result = runStep(
    "Remove the Apple secrets from the job",
    (dir) => ({ APPLE_API_KEY_PATH: path.join(dir, "AuthKey_K1.p8") }),
    (dir) => fs.writeFileSync(path.join(dir, "AuthKey_K1.p8"), PRIVATE_KEY),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.files.includes("AuthKey_K1.p8"));
  assert.deepEqual(Object.values(result.exported), ["", "", "", "", "", "", ""]);
});

test("the Windows build hands its exe to the store job", () => {
  const build = job("build");
  assert.match(build, /- name: Keep the exe for the Microsoft Store\n {8}if: runner\.os == 'Windows'\n {8}uses: actions\/upload-artifact@v4\n {8}with:\n {10}name: windows-app\n {10}path: target\/release\/skopos-app\.exe\n/);
});

test("the store job runs after publish, for stable tags only, in its own environment", () => {
  const store = job("store");
  assert.match(store, /^ {4}needs: \[verify, publish\]$/m);
  assert.match(store, /^ {4}if: needs\.verify\.outputs\.prerelease != 'true'$/m);
  assert.match(store, /^ {4}runs-on: windows-2022$/m);
  assert.match(store, /^ {4}environment: store$/m);
  assert.match(store, /msix-install-check\.ps1 -Msix .* -CheckRuntime/);
  assert.match(store, /- name: Install and start the MSIX\n {8}shell: powershell\n/);
  assert.match(store, /uses: microsoft\/setup-msstore-cli@[0-9a-f]{40} # v\S+/);
  // Nothing waits for the Store: the GitHub release never depends on it.
  assert.doesNotMatch(release, /needs: \[[^\]]*\bstore\b/);
});

test("the store job submits only when STORE_SUBMIT is true, with secrets in env only", () => {
  const store = job("store");
  for (const name of ["Install the Store CLI", "Submit to the Microsoft Store"]) {
    assert.match(store, new RegExp(`- name: ${name}\\n {8}if: vars\\.STORE_SUBMIT == 'true'\\n`));
  }
  const secretLines = store.split("\n").filter((line) => line.includes("secrets."));
  assert.ok(secretLines.length === 4, secretLines.join("\n"));
  for (const line of secretLines) {
    assert.match(line, /^ {10}(MSSTORE_[A-Z_]+): \$\{\{ secrets\.\1 \}\}$/);
  }
});
