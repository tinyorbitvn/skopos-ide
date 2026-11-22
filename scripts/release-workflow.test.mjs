import assert from "node:assert/strict";
import fs from "node:fs";
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
    '"SkoposIDE_${version}_x64-setup.exe.sig"',
    '"SkoposIDE_aarch64.app.tar.gz"',
    '"SkoposIDE_aarch64.app.tar.gz.sig"',
    '"SkoposIDE_x64.app.tar.gz"',
    '"SkoposIDE_x64.app.tar.gz.sig"',
    '"latest.json"',
  ]) {
    assert.ok(publish.includes(name), name);
  }
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
  assert.match(apple, /::error::the release environment lacks the \$name; see docs\/releasing\.md/);
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
