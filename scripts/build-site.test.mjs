import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASSET_SUFFIXES,
  formatDate,
  formatSize,
  parseRelease,
  pngSize,
  render,
} from "./build-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/vanlongme/skopos-ide";
const SIZES = {
  "amd64.AppImage": 93891064,
  "amd64.deb": 16582772,
  "aarch64.dmg": 13970570,
  "x64.dmg": 14640351,
  "x64-setup.exe": 9762270,
};

// Shaped like the answer of GET /repos/{owner}/{repo}/releases/latest.
function releaseJson(overrides = {}) {
  const download = (name) => `${REPO_URL}/releases/download/v0.6.1/${name}`;
  return {
    tag_name: "v0.6.1",
    draft: false,
    prerelease: false,
    published_at: "2026-11-16T08:01:16Z",
    html_url: `${REPO_URL}/releases/tag/v0.6.1`,
    assets: [
      ...Object.entries(SIZES).map(([suffix, size]) => ({
        name: `SkoposIDE_0.6.1_${suffix}`,
        size,
        browser_download_url: download(`SkoposIDE_0.6.1_${suffix}`),
      })),
      {
        name: "SkoposIDE_0.6.1_amd64.AppImage.sig",
        size: 420,
        browser_download_url: download("SkoposIDE_0.6.1_amd64.AppImage.sig"),
      },
    ],
    ...overrides,
  };
}

describe("formatSize", () => {
  test("writes decimal megabytes with one decimal", () => {
    assert.equal(formatSize(13970570), "14.0 MB");
    assert.equal(formatSize(9762270), "9.8 MB");
    assert.equal(formatSize(93891064), "93.9 MB");
    assert.equal(formatSize(0), "0.0 MB");
  });

  test("rejects a size that is not a non-negative number", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "14", undefined]) {
      assert.throws(() => formatSize(bad), /size/);
    }
  });
});

describe("formatDate", () => {
  test("writes the UTC day with an English month name", () => {
    assert.equal(formatDate("2026-11-16T08:01:16Z"), "16 November 2026");
  });

  test("keeps the UTC day near midnight whatever the local time zone", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      assert.equal(formatDate("2026-11-16T23:30:00Z"), "16 November 2026");
      process.env.TZ = "Etc/GMT+12"; // UTC-12
      assert.equal(formatDate("2026-11-16T00:30:00Z"), "16 November 2026");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  test("rejects a missing or invalid date", () => {
    for (const bad of [null, undefined, "", "yesterday"]) {
      assert.throws(() => formatDate(bad), /date/);
    }
  });
});

describe("parseRelease", () => {
  test("reads the version, the dates, the page and the five installers", () => {
    const release = parseRelease(releaseJson());
    assert.equal(release.version, "0.6.1");
    assert.equal(release.tag, "v0.6.1");
    assert.equal(release.date, "16 November 2026");
    assert.equal(release.isoDate, "2026-11-16");
    assert.equal(release.url, `${REPO_URL}/releases/tag/v0.6.1`);
    assert.deepEqual(Object.keys(release.assets).sort(), [...ASSET_SUFFIXES].sort());
    assert.deepEqual(release.assets["aarch64.dmg"], {
      name: "SkoposIDE_0.6.1_aarch64.dmg",
      url: `${REPO_URL}/releases/download/v0.6.1/SkoposIDE_0.6.1_aarch64.dmg`,
      size: "14.0 MB",
    });
    assert.equal(release.assets["x64-setup.exe"].size, "9.8 MB");
  });

  test("names every missing installer", () => {
    const gone = ["SkoposIDE_0.6.1_x64.dmg", "SkoposIDE_0.6.1_amd64.deb"];
    const json = releaseJson();
    json.assets = json.assets.filter((asset) => !gone.includes(asset.name));
    assert.throws(
      () => parseRelease(json),
      (err) => gone.every((name) => err.message.includes(name)),
    );
  });

  test("rejects drafts, pre-releases and answers that are not a release", () => {
    assert.throws(() => parseRelease(releaseJson({ draft: true })), /draft/);
    assert.throws(() => parseRelease(releaseJson({ prerelease: true })), /pre-release/);
    for (const bad of [null, [], "v0.6.1", {}]) {
      assert.throws(() => parseRelease(bad), /release/);
    }
  });

  test("rejects a tag that is not vX.Y.Z", () => {
    assert.throws(() => parseRelease(releaseJson({ tag_name: "nightly" })), /tag/);
  });

  test("rejects a download or page address that is not https", () => {
    const json = releaseJson();
    json.assets[0].browser_download_url = "http://downloads.test/file";
    assert.throws(() => parseRelease(json), /https/);
    assert.throws(() => parseRelease(releaseJson({ html_url: "javascript:void(0)" })), /https/);
  });
});

test("ASSET_SUFFIXES is the list the release workflow checks", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const match = /for suffix in ([^;]+); do/.exec(yml);
  assert.ok(match, "release.yml has no 'for suffix in …; do' loop");
  assert.deepEqual(match[1].trim().split(/\s+/), ASSET_SUFFIXES);
});

describe("render", () => {
  const release = parseRelease(releaseJson());
  const images = { "shot.png": { width: 1440, height: 900 } };

  test("fills every kind of placeholder", () => {
    const html = render(
      "{{release.version}}|{{release.tag}}|{{release.date}}|{{release.isoDate}}|{{release.url}}|" +
        "{{asset:x64-setup.exe:name}}|{{asset:x64-setup.exe:url}}|{{asset:x64-setup.exe:size}}|" +
        "<img {{image:shot.png}}>|{{sprite}}",
      { release, images, sprite: "<svg></svg>" },
    );
    assert.equal(
      html,
      [
        "0.6.1",
        "v0.6.1",
        "16 November 2026",
        "2026-11-16",
        `${REPO_URL}/releases/tag/v0.6.1`,
        "SkoposIDE_0.6.1_x64-setup.exe",
        `${REPO_URL}/releases/download/v0.6.1/SkoposIDE_0.6.1_x64-setup.exe`,
        "9.8 MB",
        '<img src="images/shot.png" width="1440" height="900">',
        "<svg></svg>",
      ].join("|"),
    );
  });

  test("takes image sizes from the images it is given", () => {
    const html = render("<img {{image:shot.png}}>", {
      release,
      images: { "shot.png": { width: 800, height: 600 } },
      sprite: "",
    });
    assert.equal(html, '<img src="images/shot.png" width="800" height="600">');
  });

  test("escapes release values for HTML", () => {
    const html = render("{{release.date}}", {
      release: { ...release, date: `<b>&"'` },
      images,
      sprite: "",
    });
    assert.equal(html, "&lt;b&gt;&amp;&quot;&#39;");
  });

  test("stops on a key it does not know", () => {
    const keys = [
      "release.name",
      "release.toString",
      "asset:x86.msi:url",
      "asset:constructor:name",
      "asset:x64.dmg:path",
      "image:missing.png",
      " release.version ",
      "toString",
    ];
    for (const key of keys) {
      assert.throws(
        () => render(`<p>{{${key}}}</p>`, { release, images, sprite: "" }),
        (err) => err.message.includes(key),
        key,
      );
    }
  });

  test("stops on a placeholder left open", () => {
    assert.throws(
      () => render("<p>{{release.version</p>", { release, images, sprite: "" }),
      /\{\{/,
    );
  });
});

describe("pngSize", () => {
  function pngHeader(width, height) {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12, "latin1");
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  test("reads the width and height from the IHDR chunk", () => {
    assert.deepEqual(pngSize(pngHeader(2880, 1800)), { width: 2880, height: 1800 });
  });

  test("rejects a file that is not a PNG", () => {
    assert.throws(() => pngSize(Buffer.from("GIF89a, not a PNG file, padded to length")), /PNG/);
    assert.throws(() => pngSize(Buffer.alloc(10)), /PNG/);
  });
});
