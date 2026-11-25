import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASSET_SUFFIXES,
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
const REPO_URL = "https://github.com/tinyorbitvn/skopos-ide";
// The pages link only to the repository and the maintainer's GitHub Sponsors page.
const SITE_LINK =
  /^https:\/\/(github\.com\/(tinyorbitvn\/skopos-ide($|[/#])|sponsors\/vanlongme$)|apps\.microsoft\.com\/detail\/[0-9A-Z]{12}$)/;
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

  test("the updater files beside the installers do not change what the site offers", () => {
    const json = releaseJson();
    const download = (name) => `${REPO_URL}/releases/download/v0.6.1/${name}`;
    for (const name of [
      "SkoposIDE_0.6.1_amd64.deb.sig",
      "SkoposIDE_0.6.1_x64-setup.exe.sig",
      "SkoposIDE_aarch64.app.tar.gz",
      "SkoposIDE_aarch64.app.tar.gz.sig",
      "SkoposIDE_x64.app.tar.gz",
      "SkoposIDE_x64.app.tar.gz.sig",
      "latest.json",
    ]) {
      json.assets.push({ name, size: 420, browser_download_url: download(name) });
    }
    assert.deepEqual(parseRelease(json), parseRelease(releaseJson()));
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

  test("leads image paths back to the root from a page in a folder", () => {
    const html = render("<img {{image:shot.png}}>", { release, images, sprite: "", base: "../" });
    assert.equal(html, '<img src="../images/shot.png" width="1440" height="900">');
  });

  test("names the page in its errors", () => {
    assert.throws(
      () => render("{{nope}}", { release, images, sprite: "", page: "docs/metrics.html" }),
      /site\/docs\/metrics\.html: unknown placeholder \{\{nope\}\}/,
    );
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

  test("sprite strokes each Lucide icon and draws each name once", () => {
    const svg = sprite(["download", "terminal", "download"], { readLucide });
    assert.equal(svg.match(/<symbol /g).length, 2);
    for (const name of ["download", "terminal"]) {
      assert.match(
        svg,
        new RegExp(
          `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">(<path d="[^"]+"/>)+</symbol>`,
        ),
      );
    }
    assert.match(svg, /^<!-- [^>]*Lucide[^>]*ISC[^>]*-->\n<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">/);
    assert.throws(
      () => sprite(["no-such-icon"], { readLucide }),
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

  test("copies the tokens, the five fonts, the icon and the two scripts, and writes no links", () => {
    assert.deepEqual(
      fs.readFileSync(path.join(out, "tokens.css")),
      fs.readFileSync(path.join(ROOT, "ui", "src", "design", "tinyorbit.css")),
    );
    assert.deepEqual(fs.readdirSync(path.join(out, "fonts")).sort(), FONT_FILES);
    assert.ok(fs.existsSync(path.join(out, "icon.svg")));
    for (const script of ["site.js", "ribbon.js"]) {
      assert.deepEqual(
        fs.readFileSync(path.join(out, script)),
        fs.readFileSync(path.join(ROOT, "site", script)),
        script,
      );
    }
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
// TinyOrbit colors as sRGB channels from 0 to 1, following var() references. A dark token falls
// back to the palette in the first block.
const TOKENS_CSS = fs.readFileSync(path.join(ROOT, "ui", "src", "design", "tinyorbit.css"), "utf8");
function tokenRgb(name, theme = "light") {
  const blocks = [...TOKENS_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const light = blocks.filter((m) => /:root\b|\[data-theme="light"\]/.test(m[1]));
  const dark = blocks.filter((m) => /\[data-theme="dark"\]/.test(m[1]));
  for (const [, , body] of theme === "dark" ? [...dark, ...light] : light) {
    const found = new RegExp(`(?:^|[\\s;])${name}:\\s*([^;]+);`).exec(body);
    if (!found) continue;
    const value = found[1].trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (ref) return tokenRgb(ref[1], theme);
    assert.match(value, /^#[0-9a-f]{6}$/i, name);
    return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  }
  throw new Error(`no token ${name}`);
}

function over(top, alpha, bottom) {
  return top.map((channel, i) => alpha * channel + (1 - alpha) * bottom[i]);
}

function contrast(a, b) {
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = ([r, g, bl]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(bl);
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

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

  test("is dark, with one screenshot in the light theme", () => {
    assert.ok(html.includes('<html lang="en" data-theme="dark">'));
    assert.equal(html.match(/data-theme="light"/g)?.length, 1);
    assert.ok(html.includes('<figure class="shot themes__shot" data-theme="light">'));
  });

  test("draws two ribbons, each over its glow and hidden from assistive technology", () => {
    assert.equal(html.match(/<canvas[\s>]/g)?.length, 2);
    const ribbons = [
      ...html.matchAll(
        /<div class="glow" aria-hidden="true"><\/div>\s*<canvas class="ribbon" data-ribbon data-ribbon-angle="([0-9.]+)" data-ribbon-offset="([0-9.]+)" aria-hidden="true"><\/canvas>/g,
      ),
    ];
    assert.deepEqual(
      ribbons.map((m) => [m[1], m[2]]),
      [
        ["0.74", "4"],
        ["0.32", "11"],
      ],
    );
    assert.ok(html.includes('<script src="ribbon.js" defer></script>'));
  });

  test("lays the features out as fourteen cards, each with its canvas picture", () => {
    const cards = [...html.matchAll(/<article class="card ([^"]+)">([\s\S]*?)<\/article>/g)];
    assert.deepEqual(
      cards.map((m) => m[1]),
      [
        "card--half",
        "card--half",
        "card--wide",
        "card--half",
        "card--half",
        "card--third",
        "card--third",
        "card--third",
        "card--wide",
        "card--third",
        "card--third",
        "card--third",
        "card--half",
        "card--half",
      ],
    );
    for (const [, cls, body] of cards) {
      assert.match(body, /<figure class="card__media[^"]*">\s*<img src="images\/canvas-[a-z-]+\.png"/, cls);
    }
  });

  test("gives the cards of a row pictures of one shape", () => {
    const shape = (name) => {
      const { width, height } = pngSize(fs.readFileSync(path.join(ROOT, "site", "images", name)));
      return Math.round((width / height) * 100) / 100;
    };
    const cards = [...template.matchAll(/<article class="card ([^"]+)">([\s\S]*?)<\/article>/g)];
    const byClass = new Map();
    for (const [, cls, body] of cards) {
      if (cls === "card--wide") continue;
      const name = /\{\{image:([a-z0-9-]+\.png)\}\}/.exec(body)[1];
      byClass.set(cls, [...(byClass.get(cls) ?? []), shape(name)]);
    }
    for (const [cls, shapes] of byClass) {
      assert.ok(Math.max(...shapes) - Math.min(...shapes) <= 0.02, `${cls}: ${shapes.join(", ")}`);
    }
  });

  test("hides the orbit frame, its stars and the wordmark from assistive technology", () => {
    assert.ok(html.includes('<div class="frame" aria-hidden="true"></div>'));
    const rules = html.match(/<div class="rule"[^>]*>/g) ?? [];
    assert.equal(rules.length, 7);
    for (const rule of rules) assert.equal(rule, '<div class="rule" aria-hidden="true">');
    assert.equal(html.match(/class="rule__star /g)?.length, 14);
    assert.ok(html.includes('<div class="wordmark" aria-hidden="true">SkoposIDE</div>'));
  });

  test("marks no download card without the script", () => {
    assert.ok(!html.includes("platform--mine"));
    for (const os of ["mac", "windows", "linux"]) {
      assert.ok(html.includes(`<article class="platform" data-os="${os}">`), os);
    }
    assert.equal(html.match(/<span class="tag platform__tag" hidden>Your system<\/span>/g)?.length, 3);
    // Every installer starts as a line pill; site.js turns the visitor's into the white pill.
    for (const [tag] of html.matchAll(/<a\s[^>]*data-asset="[^"]+"[^>]*>/g)) {
      assert.ok(tag.includes('class="button button--line button--sm"'), tag);
    }
  });

  test("every in-page link has its target", () => {
    for (const [, id] of html.matchAll(/href="#([a-z][a-z0-9-]*)"/g)) {
      if (!id.startsWith("i-")) assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  test("links only to the repository, its files, its releases and the sponsor page", () => {
    const urls = [...html.matchAll(/(?:href|src)="([a-z]+:[^"]*)"/g)].map((m) => m[1]);
    assert.ok(urls.length > 0);
    for (const url of urls) assert.match(url, SITE_LINK, url);
    assert.doesNotMatch(css, /https?:|@import/);
  });

  test("the hero and the call to action work without the script", () => {
    for (const id of ["hero-download", "cta-download"]) {
      assert.match(
        html,
        new RegExp(`<a class="button button--primary" id="${id}" href="#download">[^\\n]*<span data-label>Download</span>[^\\n]*</a>`),
        id,
      );
    }
    assert.ok(html.includes('v0.6.1<span id="hero-file"></span>'));
    assert.ok(html.includes('<p class="hero__alt" id="hero-alt" hidden></p>'));
  });

  test("shows the release in the hero, the stats, the cards, the downloads and the footer", () => {
    for (const text of [
      "Released 16 November 2026",
      "Everything here is in release 0.6.1",
      '<span class="stats__value">9.8 MB</span>',
      "The Windows installer is 9.8 MB.",
      'SkoposIDE <span class="grad">0.6.1</span></h2>',
      'Download <span class="grad">SkoposIDE 0.6.1</span></h2>',
      "chmod +x SkoposIDE_0.6.1_amd64.AppImage",
      "latest: v0.6.1 · 2026-11-16",
    ]) {
      assert.ok(html.includes(text), text);
    }
  });

  test("follows the copy rules outside code: no exclamation marks and no we", () => {
    const text = template
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<code>[\s\S]*?<\/code>/g, " ")
      .replace(/<!doctype html>/i, "")
      .replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, /!/);
    assert.doesNotMatch(text, /\b(we|our|us)\b/i);
  });

  test("keeps every color in the tokens", () => {
    assert.doesNotMatch(template, /\sstyle="/);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  test("describes each canvas picture in its alt text", () => {
    const imgs = [...template.matchAll(/<img \{\{image:(canvas-[a-z-]+\.png)\}\} alt="([^"]*)"/g)];
    assert.equal(imgs.length, 17);
    for (const [, name, alt] of imgs) assert.ok(alt.length >= 40, name);
  });

  test("takes every picture, the hero and Themes ones too, from the design canvas", () => {
    const names = [...template.matchAll(/\{\{image:([^}]+)\}\}/g)].map((m) => m[1]);
    assert.ok(names.includes("canvas-pods-drawer-dark.png"));
    assert.ok(names.includes("canvas-pods-drawer-light.png"));
    for (const name of names) assert.match(name, /^canvas-[a-z-]+\.png$/);
  });

  test("holds a closed lightbox dialog with a named close button for site.js", () => {
    const dialog = /<dialog class="lightbox" id="lightbox" aria-label="Enlarged picture">([\s\S]*?)<\/dialog>/.exec(template);
    assert.ok(dialog, "the dialog");
    assert.doesNotMatch(dialog[0], /\sopen[\s>]/);
    assert.match(dialog[1], /<button class="lightbox__close" type="button" aria-label="Close"><svg class="icon" aria-hidden="true"><use href="#i-x"\/><\/svg><\/button>/);
    assert.match(dialog[1], /<figcaption class="lightbox__caption" aria-hidden="true"><\/figcaption>/);
    assert.ok(html.includes('<symbol id="i-x"'), "the close icon is in the sprite");
  });

  test("links the metrics docs from the menu, the metrics card and the footer", () => {
    assert.equal(html.match(/href="docs\/metrics\.html"/g)?.length, 3);
    assert.ok(html.includes('<a class="card__link" href="docs/metrics.html">'));
  });

  test("sets page text in colors with at least 4.5:1 contrast", () => {
    // --text-tertiary (gray-500) measures 4.37:1 on white, below the spec's 4.5:1 for text.
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const pageText = rules
      .filter((m) => /(^|[;\s])color:\s*var\(--text-tertiary\)/.test(m[2]))
      .map((m) => m[1].trim().replace(/\s+/g, " "));
    assert.deepEqual(pageText, []);
  });

  test("keeps a focus outline that forced-colors mode can show", () => {
    // Forced colors drop box shadows, so the ring needs an outline; a transparent one shows there.
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const removed = rules.flatMap((m) =>
      [...m[2].matchAll(/(?:^|;)\s*(outline(?:-style|-width)?)\s*:\s*([^;]*)/g)]
        .filter(([, , value]) => value.split(/\s+/).some((word) => /^(none|hidden|0[a-z%]*)$/i.test(word)))
        .map(([, property, value]) => `${m[1].trim()} { ${property}: ${value.trim()} }`),
    );
    assert.deepEqual(removed, []);
    assert.match(css, /\n:focus-visible \{[^}]*outline: 2px solid var\(--orbit-300\);/);
  });

  test("fills no control with orbit: the primary action is the white pill", () => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const filled = rules
      .filter((m) => /\.button/.test(m[1]))
      .filter((m) => /background(-color)?:[^;]*var\(--(orbit-500|orbit-600|surface-accent)\)/.test(m[2]))
      .map((m) => m[1].trim());
    assert.deepEqual(filled, []);
    assert.match(css, /\n\.button--primary \{[^}]*background: var\(--surface-inverse\);[^}]*color: var\(--text-inverse\);/);
  });

  test("stops the gradient drift and the card hover under reduced motion", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    assert.match(block, /\.grad--move \{\s*animation: none;\s*\}/);
    assert.match(block, /\.card,[^{]*\{\s*transition: none;\s*\}/);
  });

  test("keeps the gradient text readable in forced colors", () => {
    const block = /@media \(forced-colors: active\) \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    assert.match(block, /\.grad \{\s*background: none;\s*color: CanvasText;\s*\}/);
  });

  test("drops the ribbons in forced colors, so the text sits on the system background", () => {
    // Forced colors repaint text in CanvasText but leave a canvas as drawn: dark under a light theme.
    const block = /@media \(forced-colors: active\) \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    assert.match(block, /\.ribbon \{\s*display: none;\s*\}/);
  });

  test("backs the copy over each ribbon with a scrim that grows with it", () => {
    // A fixed-size scrim left the copy's last lines on the bare ribbon once the copy grew taller.
    assert.ok(!/class="scrim/.test(html), "no fixed-size scrim in the page");
    for (const copy of ["hero__copy", "cta__copy"]) {
      assert.match(css, new RegExp(`\\n\\.${copy} \\{[^}]*width: fit-content;`), copy);
    }
    const plate = /\n\.hero__copy::before,\n\.cta__copy::before \{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.match(plate, /position: absolute;/);
    assert.match(plate, /z-index: -1;/);
    const [, top, side] = /inset: -(\d+)px -(\d+)px;/.exec(plate) ?? [];
    const [, blur] = /filter: blur\((\d+)px\);/.exec(plate) ?? [];
    assert.ok(blur, "the plate has soft edges");
    // Two blur radii in from both edges the plate keeps 97.7% of its color on each axis.
    assert.ok(Number(top) >= 2 * blur && Number(side) >= 2 * blur, "the plate reaches past the copy");
    // Opacity rather than color-mix(), which browsers before 2023 lack.
    assert.match(plate, /background: var\(--gray-950\);/, "the plate is gray-950");
    const [, share] = /opacity: (0\.\d+);/.exec(plate) ?? [];
    assert.ok(share, "the plate lets the ribbon through");
    // The ribbon's brightest pixels reach white.
    const behind = over(tokenRgb("--gray-950"), Number(share) * 0.977 ** 2, [1, 1, 1]);
    for (const name of ["--text-secondary", "--text-link"]) {
      const ratio = contrast(tokenRgb(name, "dark"), behind);
      assert.ok(ratio >= 4.5, `${name} at ${ratio.toFixed(2)}:1`);
    }
  });

  test("mentions the Next release mark only when something on the page carries it", () => {
    const marks = html.match(/class="badge next-release"/g)?.length ?? 0;
    assert.equal(/marked Next release/.test(html), marks > 0);
  });

  test("lets the call to action grow with its copy, so zoomed text is not cut off", () => {
    const rules = [...css.matchAll(/\n\s*\.cta \{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(rules.length > 0);
    assert.match(rules[0], /min-height: 540px;/);
    for (const rule of rules) assert.doesNotMatch(rule, /(^|[;\s])height:/);
  });

  test("gives each color-mix() a fallback for browsers without it, except shadows", () => {
    // A var() inside color-mix() defers the check to computed time, so a browser without it
    // resets the property instead of keeping an earlier declaration: the fallbacks sit in an
    // @supports block. A shadow or a filter that drops only loses its glow.
    const condition = "@supports not (color: color-mix(in srgb, red 50%, transparent)) {";
    const start = css.indexOf(condition);
    assert.ok(start >= 0, "the fallback block");
    let end = -1;
    for (let i = start + condition.length - 1, depth = 0; i < css.length; i++) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    const rulesOf = (text) =>
      [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
        selectors: m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")),
        declarations: m[2]
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
      }));
    const fallbacks = rulesOf(css.slice(start + condition.length, end - 1));
    const missing = [];
    for (const rule of rulesOf(css.slice(0, start) + css.slice(end))) {
      for (const [property, value] of rule.declarations) {
        if (!value.includes("color-mix(") || /^(box-shadow|filter)$/.test(property)) continue;
        for (const selector of rule.selectors) {
          const covered = fallbacks.some(
            (f) =>
              f.selectors.includes(selector) &&
              f.declarations.some(([p, v]) => p === property && !v.includes("color-mix(")),
          );
          if (!covered) missing.push(`${selector} { ${property} }`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  test("hides the orbit frame and its stars on narrow screens", () => {
    const block = /@media \(max-width: 760px\) \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    assert.match(block, /\.frame,\s*\.rule__star,\s*\.nav__links \{\s*display: none;\s*\}/);
  });
});

describe("privacy page", () => {
  const release = parseRelease(releaseJson());
  let out;
  let html;

  before(() => {
    out = tempOut();
    build({ release, out, root: ROOT });
    html = fs.readFileSync(path.join(out, "docs", "privacy.html"), "utf8");
  });
  after(() => fs.rmSync(out, { recursive: true, force: true }));

  test("renders with its title, no placeholder left and no telemetry", () => {
    assert.ok(!html.includes("{{"));
    assert.ok(html.includes("<title>Privacy · SkoposIDE docs</title>"));
    assert.match(html, /no telemetry/);
  });

  test("every relative link and source exists, from the page's folder", () => {
    const refs = [...html.matchAll(/\s(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)]
      .map((m) => m[1])
      .filter((ref) => !/^[a-z]+:/.test(ref));
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(out, "docs", ...ref.split("/"))), ref);
    }
  });

  test("the home page's Legal links lead to it", () => {
    const index = fs.readFileSync(path.join(out, "index.html"), "utf8");
    const legal = index.slice(index.indexOf('<nav aria-label="Legal">'));
    assert.ok(legal.includes('<li><a href="docs/privacy.html">Privacy</a></li>'));
  });
});

describe("docs pages", () => {
  const release = parseRelease(releaseJson());
  const template = fs.readFileSync(path.join(ROOT, "site", "docs", "metrics.html"), "utf8");
  let out;
  let html;

  before(() => {
    out = tempOut();
    build({ release, out, root: ROOT });
    html = fs.readFileSync(path.join(out, "docs", "metrics.html"), "utf8");
  });
  after(() => fs.rmSync(out, { recursive: true, force: true }));

  test("renders the metrics page with no placeholder left", () => {
    assert.ok(!html.includes("{{"));
    assert.ok(html.includes("latest: v0.6.1 · 2026-11-16"));
  });

  test("every relative link and source exists, from the page's folder", () => {
    const refs = [...html.matchAll(/\s(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)]
      .map((m) => m[1])
      .filter((ref) => !/^[a-z]+:/.test(ref));
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(out, "docs", ...ref.split("/"))), ref);
    }
  });

  test("every image has alt text and the size of its file", () => {
    const imgs = [...html.matchAll(/<img\s[^>]*>/g)].map((m) => m[0]);
    assert.ok(imgs.some((img) => img.includes("../images/canvas-settings-metrics.png")));
    for (const img of imgs) {
      assert.match(img, /\salt="[^"]*"/, img);
      const src = /\ssrc="\.\.\/(images\/[^"]+\.png)"/.exec(img)?.[1];
      if (!src) continue;
      const file = fs.readFileSync(path.join(out, ...src.split("/")));
      const width = Number(/\swidth="(\d+)"/.exec(img)?.[1]);
      const height = Number(/\sheight="(\d+)"/.exec(img)?.[1]);
      assert.deepEqual({ width, height }, pngSize(file), src);
    }
  });

  test("every icon it uses has its symbol, and every in-page link its target", () => {
    for (const [, id] of html.matchAll(/href="#(i-[a-z0-9-]+)"/g)) {
      assert.ok(html.includes(`<symbol id="${id}"`), id);
    }
    for (const [, id] of html.matchAll(/href="#([a-z][a-z0-9-]*)"/g)) {
      if (!id.startsWith("i-")) assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  test("has one h1, the landmarks, a skip link and the dark theme", () => {
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1);
    for (const part of ['<header class="nav">', '<main id="main"', '<footer class="footer">']) {
      assert.ok(html.includes(part), part);
    }
    assert.ok(html.includes('<a class="skip" href="#main">Skip to content</a>'));
    assert.ok(html.includes('<html lang="en" data-theme="dark">'));
    assert.ok(html.includes('<a href="metrics.html" aria-current="page">Docs</a>'));
  });

  test("links only to the repository, its files, its releases and the sponsor page", () => {
    const urls = [...html.matchAll(/(?:href|src)="([a-z]+:[^"]*)"/g)].map((m) => m[1]);
    for (const url of urls) assert.match(url, SITE_LINK, url);
  });

  test("follows the copy rules outside code: no exclamation marks and no we", () => {
    const text = template
      .replace(/<code>[\s\S]*?<\/code>/g, " ")
      .replace(/<!doctype html>/i, "")
      .replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, /!/);
    assert.doesNotMatch(text, /\b(we|our|us)\b/i);
    assert.doesNotMatch(template, /\sstyle="/);
  });

  test("names the settings the app shows and the series its queries read", () => {
    const settings = fs.readFileSync(
      path.join(ROOT, "ui", "src", "features", "settings", "ClusterSettingsScreen.tsx"),
      "utf8",
    );
    for (const label of [
      "Detect",
      "Prometheus or Mimir in the cluster",
      "Prometheus-compatible URL",
      "metrics-server only",
      "Namespace",
      "Service",
      "Port",
      "Scheme",
      "Path prefix",
      "Tenant",
      "URL",
      "Authentication",
    ]) {
      assert.ok(settings.includes(`label: "${label}"`) || settings.includes(`label="${label}"`), label);
      assert.ok(template.includes(label), label);
    }
    const metrics = path.join(ROOT, "crates", "skopos-core", "src", "metrics");
    const queries = fs.readFileSync(path.join(metrics, "templates.rs"), "utf8");
    const series = new Set([...template.matchAll(/<code>([a-z_]+_(?:total|bytes|bucket|info|phase|requests|limits|allocatable|capacity))<\/code>/g)].map((m) => m[1]));
    assert.ok(series.size >= 20, `${series.size} series`);
    for (const name of series) assert.ok(queries.includes(`"${name}"`), name);
    const detect = fs.readFileSync(path.join(metrics, "detect.rs"), "utf8");
    for (const value of ["kube-prometheus-stack-prometheus", "operated-prometheus", "http-web", "monitoring"]) {
      assert.ok(detect.includes(`"${value}"`) && template.includes(value), value);
    }
  });
});
