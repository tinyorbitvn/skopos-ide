import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXECUTABLE,
  TEST_IDENTITY,
  escapeXml,
  msixName,
  packageVersion,
  readIdentity,
  renderManifest,
} from "./msix.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = fs.readFileSync(
  path.join(ROOT, "crates", "skopos-app", "msix", "AppxManifest.xml"),
  "utf8",
);
const values = (identity = TEST_IDENTITY) => ({
  ...identity,
  version: "0.13.1.0",
  executable: EXECUTABLE,
});

// Scratch folders live under the git-ignored tmp/ of the checkout, not the system temp dir.
function scratchDir() {
  const base = path.join(ROOT, "tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "msix-"));
}

test("a stable version gets a zero revision; anything else is refused", () => {
  assert.equal(packageVersion("0.13.1"), "0.13.1.0");
  for (const bad of ["0.14.0-rc.1", "1.2", "v1.2.3", "1.2.3.4", ""]) {
    assert.throws(() => packageVersion(bad), /stable versions only/);
  }
  assert.equal(msixName("0.13.1"), "SkoposIDE_0.13.1_x64.msix");
});

test("the identity comes from test or from a file with every field", () => {
  assert.deepEqual(readIdentity("test"), TEST_IDENTITY);
  const dir = scratchDir();
  const file = path.join(dir, "store.json");
  fs.writeFileSync(file, JSON.stringify({ name: "A.B", publisherDisplayName: "X" }));
  assert.throws(() => readIdentity(file), /publisher is missing/);
});

test("identity values are escaped, non-ASCII text passes through", () => {
  assert.equal(
    escapeXml(`CN=Nguyễn & Co, O="X" <y> 'z'`),
    "CN=Nguyễn &amp; Co, O=&quot;X&quot; &lt;y&gt; &apos;z&apos;",
  );
  const xml = renderManifest(TEMPLATE, values({ ...TEST_IDENTITY, publisher: `CN=Nguyễn & Co, O="X"` }));
  assert.match(xml, /Publisher="CN=Nguyễn &amp; Co, O=&quot;X&quot;"/);
});

test("the manifest names the package, the exe, full trust and unvirtualized writes", () => {
  const xml = renderManifest(TEMPLATE, values());
  assert.doesNotMatch(xml, /\{\{/);
  assert.match(xml, /<Identity Name="SkoposIDE\.Test" Publisher="CN=SkoposIDE Test" Version="0\.13\.1\.0" ProcessorArchitecture="x64"\/>/);
  assert.match(xml, /<Application Id="SkoposIDE" Executable="SkoposIDE\.exe" EntryPoint="Windows\.FullTrustApplication">/);
  assert.match(xml, /<rescap:Capability Name="runFullTrust"\/>/);
  assert.match(xml, /<rescap:Capability Name="unvirtualizedResources"\/>/);
  assert.match(xml, /<desktop6:FileSystemWriteVirtualization>disabled<\/desktop6:FileSystemWriteVirtualization>/);
  assert.match(xml, /<desktop6:RegistryWriteVirtualization>disabled<\/desktop6:RegistryWriteVirtualization>/);
  assert.match(xml, /MinVersion="10\.0\.19041\.0"/);
});

test("an unknown template value is an error, not an empty attribute", () => {
  assert.throws(() => renderManifest("{{nope}}", values()), /unknown value: \{\{nope\}\}/);
});

test("--render-only lays out the exe, the notices, the assets and the manifest", () => {
  const dir = scratchDir();
  const exe = path.join(dir, "skopos-app.exe");
  fs.writeFileSync(exe, "MZ");
  const out = path.join(dir, "out");
  const run = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "msix.mjs"),
    "--exe", exe, "--identity", "test", "--version", "0.13.1", "--out", out, "--render-only",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const layout = path.join(out, "layout");
  for (const file of [
    "SkoposIDE.exe", "LICENSE", "THIRD_PARTY_NOTICES.md", "AppxManifest.xml",
    path.join("Assets", "StoreLogo.png"), path.join("Assets", "Square44x44Logo.png"),
    path.join("Assets", "Square150x150Logo.png"),
  ]) {
    assert.ok(fs.existsSync(path.join(layout, file)), file);
  }
  assert.match(fs.readFileSync(path.join(layout, "AppxManifest.xml"), "utf8"), /Version="0\.13\.1\.0"/);
});

test("a pre-release version stops the script before it writes anything", () => {
  const dir = scratchDir();
  const run = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "msix.mjs"),
    "--exe", path.join(dir, "missing.exe"), "--identity", "test",
    "--version", "0.14.0-rc.1", "--out", path.join(dir, "out"), "--render-only",
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /stable versions only/);
  assert.equal(fs.existsSync(path.join(dir, "out")), false);
});

test("the Windows smoke job packs the e2e build and install-checks it", () => {
  const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const smoke = ci.slice(ci.indexOf("\n  smoke:\n"), ci.indexOf("\n  sbom:\n"));
  assert.match(smoke, /- name: Pack the MSIX\n {8}if: runner\.os == 'Windows'\n/);
  assert.match(smoke, /node scripts\/msix\.mjs --exe target\/debug\/skopos-app\.exe --identity test /);
  assert.match(smoke, /--version "\$\{version%%-\*\}"/);
  assert.match(smoke, /- name: Install and start the MSIX\n {8}if: runner\.os == 'Windows'\n {8}shell: pwsh\n {8}run: \.\/scripts\/msix-install-check\.ps1 -Msix /);
  assert.doesNotMatch(smoke, /-CheckRuntime/);
});

test("store.json holds the Partner Center identity and the site links its Store page", () => {
  const file = path.join(ROOT, "crates", "skopos-app", "msix", "store.json");
  const identity = readIdentity(file);
  assert.match(identity.publisher, /^CN=/);
  const { storeId } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(storeId, /^[0-9A-Z]{12}$/);
  const site = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
  assert.ok(site.includes(`href="https://apps.microsoft.com/detail/${storeId}"`));
});
