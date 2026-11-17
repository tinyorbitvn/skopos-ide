import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASSET_SUFFIXES,
  appGlyphs,
  assertSafeOut,
  build,
  cli,
  formatDate,
  formatSize,
  lucideNodes,
  parseRelease,
  pngSize,
  render,
  sprite,
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
const GLYPHS_TS = path.join(ROOT, "ui", "src", "design", "glyphPaths.ts");
const LUCIDE_ICONS = path.join(ROOT, "ui", "node_modules", "lucide-react", "dist", "esm", "icons");
const FONT_FILES = [
  "jetbrains-mono-latin-400-normal.woff2",
  "jetbrains-mono-latin-500-normal.woff2",
  "manrope-latin-400-normal.woff2",
  "manrope-latin-500-normal.woff2",
  "manrope-latin-600-normal.woff2",
];

// A fresh empty folder in the repository's git-ignored tmp/, one of the places
// assertSafeOut lets the build replace.
function tempOut() {
  const base = path.join(ROOT, "tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "site-test-"));
}

function readLucide(name) {
  const file = path.join(LUCIDE_ICONS, `${name}.mjs`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

describe("icons", () => {
  const ts = fs.readFileSync(GLYPHS_TS, "utf8");

  test("appGlyphs reads every glyph the app draws", () => {
    const glyphs = appGlyphs(ts);
    const names = [...ts.matchAll(/^\s*\|\s*"([a-z0-9-]+)"/gm)].map((m) => m[1]);
    assert.ok(names.length > 0);
    assert.deepEqual([...glyphs.keys()].sort(), names.sort());
    for (const d of glyphs.values()) assert.match(d, /^M[0-9.\sA-Za-z-]+$/);
  });

  test("lucideNodes reads a Lucide icon's elements, without React keys", () => {
    const nodes = lucideNodes(fs.readFileSync(path.join(LUCIDE_ICONS, "network.mjs"), "utf8"));
    assert.deepEqual(
      nodes.map((node) => node.tag),
      ["rect", "rect", "rect", "path", "path"],
    );
    assert.deepEqual(nodes[0].attrs, [
      ["x", "16"],
      ["y", "16"],
      ["width", "6"],
      ["height", "6"],
      ["rx", "1"],
    ]);
    for (const node of nodes) assert.ok(node.attrs.every(([name]) => name !== "key"));
    assert.throws(() => lucideNodes("export default {};"), /no SVG elements/);
  });

  test("sprite fills the app's glyphs, strokes Lucide icons and draws each name once", () => {
    const svg = sprite(["download", "trash-2", "download"], { glyphs: appGlyphs(ts), readLucide });
    assert.equal(svg.match(/<symbol /g).length, 2);
    assert.match(
      svg,
      /<symbol id="i-trash-2" viewBox="0 0 24 24"><path d="M[^"]+" fill="currentColor" stroke="none" fill-rule="evenodd"\/><\/symbol>/,
    );
    assert.match(
      svg,
      /<symbol id="i-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">(<path d="[^"]+"\/>)+<\/symbol>/,
    );
    assert.match(svg, /^<!-- [^>]*Lucide[^>]*ISC[^>]*-->\n<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">/);
    assert.throws(
      () => sprite(["no-such-icon"], { glyphs: appGlyphs(ts), readLucide }),
      /no-such-icon/,
    );
  });
});

describe("assertSafeOut", () => {
  test("accepts tmp/site, the tests' folders and new folders outside the repository", () => {
    for (const out of [
      path.join(ROOT, "tmp", "site"),
      path.join(ROOT, "tmp", "site-test-abc"),
      path.join(os.tmpdir(), "skopos-site-no-such-folder"),
    ]) {
      assert.equal(assertSafeOut(out, ROOT), out);
    }
  });

  test("refuses the repository, its ancestors and other folders inside it", () => {
    for (const out of [
      ROOT,
      path.dirname(ROOT),
      path.parse(ROOT).root,
      path.join(ROOT, "site"),
      path.join(ROOT, "tmp"),
      path.join(ROOT, "tmp", "worktrees"),
      path.join(ROOT, "tmp", "site-canvas"),
      path.join(ROOT, "tmp", "site", "nested"),
      path.join(ROOT, "ui", "dist"),
    ]) {
      assert.throws(() => assertSafeOut(out, ROOT), /^Error: refusing/, out);
    }
  });

  test("refuses a folder that is not empty and holds no previous build", (t) => {
    const dir = tempOut();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
    assert.throws(() => assertSafeOut(dir, ROOT), /refusing/);
    fs.writeFileSync(path.join(dir, "index.html"), "previous build");
    fs.writeFileSync(path.join(dir, "tokens.css"), "previous build");
    assert.equal(assertSafeOut(dir, ROOT), dir);
  });
});

describe("build", () => {
  const release = parseRelease(releaseJson());
  let out;
  let html;

  before(() => {
    out = tempOut();
    build({ release, out, root: ROOT });
    html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  });
  after(() => fs.rmSync(out, { recursive: true, force: true }));

  test("leaves no placeholder", () => {
    assert.ok(!html.includes("{{"));
  });

  test("every relative link and source exists in the output", () => {
    const css = fs.readFileSync(path.join(out, "site.css"), "utf8");
    const refs = [
      ...[...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
      ...[...css.matchAll(/url\("?([^")]+)"?\)/g)].map((m) => m[1]),
    ].filter((ref) => !ref.startsWith("#") && !/^[a-z]+:/.test(ref));
    assert.ok(refs.length > 0);
    for (const ref of refs) assert.ok(fs.existsSync(path.join(out, ...ref.split("/"))), ref);
  });

  test("links each installer once, with its address, name and size", () => {
    const links = [...html.matchAll(/<a\s[^>]*data-asset="([^"]+)"[^>]*>/g)];
    assert.deepEqual(links.map((m) => m[1]).sort(), [...ASSET_SUFFIXES].sort());
    for (const [tag, suffix] of links) {
      const asset = release.assets[suffix];
      assert.ok(tag.includes(`href="${asset.url}"`), tag);
      assert.ok(tag.includes(`data-name="${asset.name}"`), tag);
      assert.ok(tag.includes(`data-size="${asset.size}"`), tag);
    }
  });

  test("every image has alt text and the size of its file", () => {
    const imgs = [...html.matchAll(/<img\s[^>]*>/g)].map((m) => m[0]);
    assert.ok(imgs.length > 0);
    for (const img of imgs) {
      assert.match(img, /\salt="[^"]*"/, img);
      const width = /\swidth="(\d+)"/.exec(img)?.[1];
      const height = /\sheight="(\d+)"/.exec(img)?.[1];
      assert.ok(width && height, img);
      const src = /\ssrc="(images\/[^"]+\.png)"/.exec(img)?.[1];
      if (src) {
        const file = fs.readFileSync(path.join(out, ...src.split("/")));
        assert.deepEqual({ width: Number(width), height: Number(height) }, pngSize(file), src);
      }
    }
  });

  test("every icon the page uses has its symbol", () => {
    const used = new Set([...html.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
    assert.ok(used.size > 0);
    for (const id of used) assert.ok(html.includes(`<symbol id="${id}"`), id);
  });

  test("copies the tokens, the five fonts and the icon, and writes no links", () => {
    assert.deepEqual(
      fs.readFileSync(path.join(out, "tokens.css")),
      fs.readFileSync(path.join(ROOT, "ui", "src", "design", "tinyorbit.css")),
    );
    assert.deepEqual(fs.readdirSync(path.join(out, "fonts")).sort(), FONT_FILES);
    assert.ok(fs.existsSync(path.join(out, "icon.svg")));
    assert.ok(fs.existsSync(path.join(out, "site.js")));
    for (const entry of fs.readdirSync(out, { recursive: true })) {
      assert.ok(!fs.lstatSync(path.join(out, entry)).isSymbolicLink(), entry);
    }
  });
});

describe("cli", () => {
  function releaseFile(t, json) {
    const dir = tempOut();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "release.json");
    fs.writeFileSync(file, JSON.stringify(json));
    return file;
  }

  test("an invalid release leaves the previous build as it was", (t) => {
    const out = tempOut();
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    fs.writeFileSync(path.join(out, "index.html"), "previous build");
    fs.writeFileSync(path.join(out, "tokens.css"), "previous build");
    const json = releaseJson();
    json.assets = json.assets.filter((asset) => asset.name !== "SkoposIDE_0.6.1_x64-setup.exe");
    const file = releaseFile(t, json);
    assert.throws(() => cli(["--out", out, "--release-json", file], { root: ROOT }), /x64-setup\.exe/);
    assert.deepEqual(fs.readdirSync(out).sort(), ["index.html", "tokens.css"]);
    assert.equal(fs.readFileSync(path.join(out, "index.html"), "utf8"), "previous build");
  });

  test("builds from a release file without asking GitHub", (t) => {
    const out = tempOut();
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const file = releaseFile(t, releaseJson());
    const fetchRelease = () => {
      throw new Error("must not fetch when --release-json is given");
    };
    const result = cli(["--out", out, "--release-json", file], { root: ROOT, fetchRelease });
    assert.equal(result.release.tag, "v0.6.1");
    assert.equal(result.out, out);
    assert.ok(fs.readFileSync(path.join(out, "index.html"), "utf8").includes("SkoposIDE_0.6.1_x64-setup.exe"));
  });

  test("rejects unknown arguments and a missing --out", () => {
    assert.throws(() => cli([], { root: ROOT }), /usage/);
    assert.throws(() => cli(["--out"], { root: ROOT }), /usage/);
    assert.throws(() => cli(["--out", "tmp/site", "--publish"], { root: ROOT }), /unknown argument/);
  });
});
describe("page", () => {
  const release = parseRelease(releaseJson());
  const template = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "site", "site.css"), "utf8");
  let out;
  let html;

  before(() => {
    out = tempOut();
    build({ release, out, root: ROOT });
    html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  });
  after(() => fs.rmSync(out, { recursive: true, force: true }));

  test("has one h1, the landmarks and a skip link", () => {
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1);
    for (const part of ['<header class="nav">', '<main id="main">', '<footer class="footer">']) {
      assert.ok(html.includes(part), part);
    }
    assert.ok(html.includes('<a class="skip" href="#main">Skip to content</a>'));
  });

  test("has one Orbit-filled button and one dark band", () => {
    assert.equal(html.match(/button--primary/g)?.length, 1);
    assert.equal(html.match(/class="band"/g)?.length, 1);
  });

  test("every in-page link has its target", () => {
    for (const [, id] of html.matchAll(/href="#([a-z][a-z0-9-]*)"/g)) {
      if (!id.startsWith("i-")) assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  test("links only to the repository, its files and its releases", () => {
    const urls = [...html.matchAll(/(?:href|src)="([a-z]+:[^"]*)"/g)].map((m) => m[1]);
    assert.ok(urls.length > 0);
    for (const url of urls) assert.match(url, /^https:\/\/github\.com\/vanlongme\/skopos-ide($|[/#])/);
    assert.doesNotMatch(css, /https?:|@import/);
  });

  test("the hero works without the script", () => {
    assert.match(
      html,
      /<a class="button button--primary button--lg" id="hero-download" href="#download">.*<span data-label>Download<\/span><\/a>/,
    );
    assert.ok(html.includes('v0.6.1<span id="hero-file"></span>'));
    assert.ok(html.includes('<p class="hero__alt" id="hero-alt" hidden></p>'));
  });

  test("shows the release in the hero, the stats, the cards, the downloads and the footer", () => {
    for (const text of [
      "Released 16 November 2026",
      "Everything here is in release 0.6.1",
      '<span class="stats__value">9.8 MB</span>',
      "The Windows installer is 9.8 MB.",
      "SkoposIDE 0.6.1</h2>",
      "chmod +x SkoposIDE_0.6.1_amd64.AppImage",
      "latest: v0.6.1 · 2026-11-16",
    ]) {
      assert.ok(html.includes(text), text);
    }
  });

  test("follows the copy rules: no exclamation marks and no we", () => {
    const text = template
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!doctype html>/i, "")
      .replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, /!/);
    assert.doesNotMatch(text, /\b(we|our|us)\b/i);
  });

  test("keeps every color in the tokens", () => {
    assert.doesNotMatch(template, /\sstyle="/);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  test("labels the four drawn figures", () => {
    for (const id of ["mock-dock", "mock-map", "mock-metrics", "mock-apps"]) {
      assert.match(
        template,
        new RegExp(`<figure class="feature__media shot mock[^"]*" id="${id}" role="img" aria-label="[^"]{20,}">`),
        id,
      );
    }
  });
});
