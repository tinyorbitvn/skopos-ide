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

test("only the release build makes updater files, through an extra configuration", () => {
  assert.deepEqual(JSON.parse(read("crates", "skopos-app", "tauri.updater.conf.json")), {
    bundle: { createUpdaterArtifacts: true },
  });
  const build = job("build");
  assert.match(
    build,
    /^ {10}args: \$\{\{ matrix\.args \}\} --config crates\/skopos-app\/tauri\.conf\.json --config crates\/skopos-app\/tauri\.updater\.conf\.json$/m,
  );
  assert.match(build, /^ {10}uploadUpdaterJson: false$/m);
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
  inOrder(build, ["secrets.TAURI_SIGNING_PRIVATE_KEY != ''", "uses: tauri-apps/tauri-action@v0"]);
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
