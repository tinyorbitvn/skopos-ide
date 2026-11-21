import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  buildManifest,
  cli,
  manifestUrls,
  PLATFORMS,
  REPO_URL,
  readSignatures,
  rfc3339,
} from "./updater-manifest.mjs";

const VERSION = "0.10.0";
const UPDATER_FILES = [
  "SkoposIDE_aarch64.app.tar.gz",
  "SkoposIDE_x64.app.tar.gz",
  `SkoposIDE_${VERSION}_amd64.AppImage`,
  `SkoposIDE_${VERSION}_amd64.deb`,
  `SkoposIDE_${VERSION}_x64-setup.exe`,
];
// What a draft holds after the four builds.
const ASSETS = [
  ...UPDATER_FILES,
  ...UPDATER_FILES.map((name) => `${name}.sig`),
  `SkoposIDE_${VERSION}_aarch64.dmg`,
  `SkoposIDE_${VERSION}_x64.dmg`,
];
const SIGNATURES = Object.fromEntries(
  UPDATER_FILES.map((name) => [name, `sig-of-${name}\n`]),
);
const input = (over = {}) => ({
  version: VERSION,
  notes: "- Faster lists",
  pubDate: "2026-11-25T12:00:00Z",
  assets: ASSETS,
  signatures: SIGNATURES,
  ...over,
});
const download = (name) => `${REPO_URL}/releases/download/v${VERSION}/${name}`;

describe("buildManifest", () => {
  test("names every platform the plugin looks up, pinned to the version", () => {
    const manifest = buildManifest(input());
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.notes, "- Faster lists");
    assert.equal(manifest.pub_date, "2026-11-25T12:00:00Z");
    assert.deepEqual(manifest.platforms, {
      "darwin-aarch64-app": {
        signature: "sig-of-SkoposIDE_aarch64.app.tar.gz",
        url: download("SkoposIDE_aarch64.app.tar.gz"),
      },
      "darwin-aarch64": {
        signature: "sig-of-SkoposIDE_aarch64.app.tar.gz",
        url: download("SkoposIDE_aarch64.app.tar.gz"),
      },
      "darwin-x86_64-app": {
        signature: "sig-of-SkoposIDE_x64.app.tar.gz",
        url: download("SkoposIDE_x64.app.tar.gz"),
      },
      "darwin-x86_64": {
        signature: "sig-of-SkoposIDE_x64.app.tar.gz",
        url: download("SkoposIDE_x64.app.tar.gz"),
      },
      "linux-x86_64-appimage": {
        signature: `sig-of-SkoposIDE_${VERSION}_amd64.AppImage`,
        url: download(`SkoposIDE_${VERSION}_amd64.AppImage`),
      },
      "linux-x86_64": {
        signature: `sig-of-SkoposIDE_${VERSION}_amd64.AppImage`,
        url: download(`SkoposIDE_${VERSION}_amd64.AppImage`),
      },
      "linux-x86_64-deb": {
        signature: `sig-of-SkoposIDE_${VERSION}_amd64.deb`,
        url: download(`SkoposIDE_${VERSION}_amd64.deb`),
      },
      "windows-x86_64-nsis": {
        signature: `sig-of-SkoposIDE_${VERSION}_x64-setup.exe`,
        url: download(`SkoposIDE_${VERSION}_x64-setup.exe`),
      },
      "windows-x86_64": {
        signature: `sig-of-SkoposIDE_${VERSION}_x64-setup.exe`,
        url: download(`SkoposIDE_${VERSION}_x64-setup.exe`),
      },
    });
    assert.deepEqual(
      Object.keys(manifest.platforms),
      PLATFORMS.map(([key]) => key),
    );
  });

  test("names every missing file and signature, and builds nothing", () => {
    const assets = ASSETS.filter((name) => name !== "SkoposIDE_x64.app.tar.gz");
    const signatures = { ...SIGNATURES };
    delete signatures[`SkoposIDE_${VERSION}_amd64.deb`];
    assert.throws(
      () => buildManifest(input({ assets, signatures })),
      (err) =>
        err.message.includes(
          "darwin-x86_64-app: no file ending in _x64.app.tar.gz",
        ) &&
        err.message.includes(
          `linux-x86_64-deb: no signature for SkoposIDE_${VERSION}_amd64.deb`,
        ),
    );
  });

  test("an empty signature counts as missing", () => {
    const signatures = { ...SIGNATURES, "SkoposIDE_aarch64.app.tar.gz": " \n" };
    assert.throws(
      () => buildManifest(input({ signatures })),
      /darwin-aarch64-app: no signature/,
    );
  });

  test("two files for one platform is a mistake, not a choice", () => {
    const assets = [...ASSETS, `SkoposIDE_0.9.0_amd64.deb`];
    assert.throws(
      () => buildManifest(input({ assets })),
      /linux-x86_64-deb: 2 files end in _amd64\.deb/,
    );
  });

  test("the version must be x.y.z, with an optional pre-release", () => {
    assert.throws(
      () => buildManifest(input({ version: "v0.10.0" })),
      /version/,
    );
    assert.equal(
      buildManifest(input({ version: "0.10.0-rc.1" })).version,
      "0.10.0-rc.1",
    );
  });
});

test("rfc3339 drops the milliseconds", () => {
  assert.equal(
    rfc3339(new Date("2026-11-25T12:00:00.123Z")),
    "2026-11-25T12:00:00Z",
  );
});

describe("manifestUrls", () => {
  test("lists each download once when the manifest names the version on every platform", () => {
    const manifest = buildManifest(input());
    assert.deepEqual(
      manifestUrls(manifest, VERSION),
      UPDATER_FILES.map(download),
    );
  });

  test("rejects another version, a missing platform and an address of another release", () => {
    const manifest = buildManifest(input());
    assert.throws(
      () => manifestUrls(manifest, "0.11.0"),
      /names "0\.10\.0", not 0\.11\.0/,
    );
    const missing = structuredClone(manifest);
    delete missing.platforms["linux-x86_64-deb"];
    assert.throws(
      () => manifestUrls(missing, VERSION),
      /linux-x86_64-deb is missing/,
    );
    const moved = structuredClone(manifest);
    moved.platforms["windows-x86_64"].url = download("x.exe").replace(
      "v0.10.0",
      "v0.9.0",
    );
    assert.throws(
      () => manifestUrls(moved, VERSION),
      /windows-x86_64 points at/,
    );
    const swapped = structuredClone(manifest);
    swapped.platforms["windows-x86_64"].url =
      swapped.platforms["linux-x86_64-deb"].url;
    assert.throws(
      () => manifestUrls(swapped, VERSION),
      /windows-x86_64 points at .*\.deb/,
    );
    for (const bad of [null, [], "latest"]) {
      assert.throws(() => manifestUrls(bad, VERSION), /latest\.json/);
    }
  });
});

describe("cli", () => {
  function workDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-manifest-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "sigs"));
    for (const [name, signature] of Object.entries(SIGNATURES)) {
      fs.writeFileSync(path.join(dir, "sigs", `${name}.sig`), signature);
    }
    fs.writeFileSync(path.join(dir, "assets.txt"), `${ASSETS.join("\n")}\n`);
    fs.writeFileSync(path.join(dir, "notes.md"), "- Faster lists\n");
    return dir;
  }

  test("readSignatures keys each .sig file by its asset", (t) => {
    const dir = workDir(t);
    fs.writeFileSync(path.join(dir, "sigs", "README"), "not a signature");
    assert.deepEqual(readSignatures(path.join(dir, "sigs")), SIGNATURES);
  });

  test("build writes latest.json, and urls reads it back", (t) => {
    const dir = workDir(t);
    const out = path.join(dir, "latest.json");
    const now = new Date("2026-11-25T12:00:00.456Z");
    cli(
      [
        "build",
        "--version",
        VERSION,
        "--notes",
        path.join(dir, "notes.md"),
        "--assets",
        path.join(dir, "assets.txt"),
        "--sigs",
        path.join(dir, "sigs"),
        "--out",
        out,
      ],
      now,
    );
    const manifest = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(manifest.pub_date, "2026-11-25T12:00:00Z");
    assert.equal(manifest.notes, "- Faster lists");
    assert.equal(
      cli(["urls", "--version", VERSION, "--file", out]),
      `${UPDATER_FILES.map(download).join("\n")}\n`,
    );
  });

  test("a failed build writes nothing", (t) => {
    const dir = workDir(t);
    fs.rmSync(path.join(dir, "sigs", "SkoposIDE_x64.app.tar.gz.sig"));
    const out = path.join(dir, "latest.json");
    assert.throws(
      () =>
        cli([
          "build",
          "--version",
          VERSION,
          "--notes",
          path.join(dir, "notes.md"),
          "--assets",
          path.join(dir, "assets.txt"),
          "--sigs",
          path.join(dir, "sigs"),
          "--out",
          out,
        ]),
      /darwin-x86_64-app: no signature/,
    );
    assert.equal(fs.existsSync(out), false);
  });

  test("an unknown command or a missing option prints the usage", () => {
    assert.throws(() => cli(["publish"]), /usage:/);
    assert.throws(() => cli(["build", "--version", VERSION]), /usage:/);
  });
});
