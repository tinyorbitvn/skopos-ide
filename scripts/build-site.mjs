// Builds the project site in site/ into a folder GitHub Pages can serve, with the
// downloads of the latest release filled in.
// Usage: node scripts/build-site.mjs --out <dir> [--release-json <file>]
// See docs/releasing.md, "Project site".

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONTS = [
  ["manrope", "manrope-latin-400-normal.woff2"],
  ["manrope", "manrope-latin-500-normal.woff2"],
  ["manrope", "manrope-latin-600-normal.woff2"],
  ["jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2"],
  ["jetbrains-mono", "jetbrains-mono-latin-500-normal.woff2"],
];
const LUCIDE_TAGS = "path|circle|rect|line|polyline|polygon|ellipse";
const USAGE = "usage: node scripts/build-site.mjs --out <dir> [--release-json <file>]";

/** The installers every release publishes, as the publish job of release.yml checks. */
export const ASSET_SUFFIXES = [
  "amd64.AppImage",
  "amd64.deb",
  "aarch64.dmg",
  "x64.dmg",
  "x64-setup.exe",
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const RELEASE_KEYS = new Set(["version", "tag", "date", "isoDate", "url"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Decimal megabytes with one decimal: 13970570 → "14.0 MB". */
export function formatSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`release: invalid asset size ${JSON.stringify(bytes)}`);
  }
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** The UTC day of an ISO timestamp, such as "16 November 2026". */
export function formatDate(iso) {
  const date = typeof iso === "string" ? new Date(iso) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`release: invalid date ${JSON.stringify(iso)}`);
  }
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function httpsUrl(value, what) {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    throw new Error(`release: ${what} is not an https URL: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Checks a GitHub release answer and keeps what the page shows. */
export function parseRelease(json) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("release: expected a JSON object from the releases API");
  }
  if (json.draft || json.prerelease) {
    throw new Error(
      `release ${json.tag_name}: drafts and pre-releases are not published on the site`,
    );
  }
  const tag = json.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`release: tag_name ${JSON.stringify(tag)} is not vX.Y.Z`);
  }
  const version = tag.slice(1);
  const url = httpsUrl(json.html_url, "html_url");
  const date = formatDate(json.published_at);
  const isoDate = new Date(json.published_at).toISOString().slice(0, 10);
  const list = Array.isArray(json.assets) ? json.assets : [];
  const assets = {};
  const missing = [];
  for (const suffix of ASSET_SUFFIXES) {
    const name = `SkoposIDE_${version}_${suffix}`;
    const asset = list.find((item) => item && item.name === name);
    if (!asset) {
      missing.push(name);
      continue;
    }
    assets[suffix] = {
      name,
      url: httpsUrl(asset.browser_download_url, name),
      size: formatSize(asset.size),
    };
  }
  if (missing.length > 0) {
    throw new Error(`release ${tag}: missing assets: ${missing.join(", ")}`);
  }
  return { version, tag, date, isoDate, url, assets };
}

/** The width and height in a PNG file's IHDR chunk. */
export function pngSize(buf) {
  if (
    buf.length < 24 ||
    !buf.subarray(0, 8).equals(PNG_SIGNATURE) ||
    buf.toString("latin1", 12, 16) !== "IHDR"
  ) {
    throw new Error("not a PNG file");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Fills a page's placeholders:
 *   {{release.version|tag|date|isoDate|url}}, {{asset:<suffix>:name|url|size}},
 *   {{image:<file>.png}} (src, width and height) and {{sprite}}.
 * `base` leads image paths back to the site's root from a page in a folder, such as "../";
 * `page` names the page in errors. An unknown key or a placeholder left open is an error.
 */
export function render(template, { release, images, sprite, base = "", page = "index.html" }) {
  const html = template.replace(/\{\{([^{}]*)\}\}/g, (_, key) => {
    if (key === "sprite") return sprite;
    let match = /^release\.(\w+)$/.exec(key);
    if (match && RELEASE_KEYS.has(match[1])) return escapeHtml(release[match[1]]);
    match = /^asset:([\w.-]+):(name|url|size)$/.exec(key);
    if (match && Object.hasOwn(release.assets, match[1])) {
      return escapeHtml(release.assets[match[1]][match[2]]);
    }
    match = /^image:([a-z0-9-]+\.png)$/.exec(key);
    if (match && Object.hasOwn(images, match[1])) {
      const { width, height } = images[match[1]];
      return `src="${base}images/${match[1]}" width="${width}" height="${height}"`;
    }
    throw new Error(`site/${page}: unknown placeholder {{${key}}}`);
  });
  const open = html.indexOf("{{");
  if (open !== -1) {
    throw new Error(
      `site/${page}: placeholder left open near ${JSON.stringify(html.slice(open, open + 40))}`,
    );
  }
  return html;
}

/** The SVG elements of a lucide-react icon module, without React's keys. */
export function lucideNodes(mjs) {
  const nodes = [];
  const element = new RegExp(`\\[\\s*"(${LUCIDE_TAGS})",\\s*\\{([^}]*)\\}\\s*\\]`, "g");
  for (const m of mjs.matchAll(element)) {
    const attrs = [];
    for (const a of m[2].matchAll(/(?:"([\w-]+)"|([\w-]+)):\s*"([^"]*)"/g)) {
      const name = a[1] ?? a[2];
      if (name !== "key") attrs.push([name, a[3]]);
    }
    nodes.push({ tag: m[1], attrs });
  }
  if (nodes.length === 0) throw new Error("lucide icon: no SVG elements found");
  return nodes;
}

/**
 * A hidden SVG sprite with one <symbol id="i-<name>"> per name: the Lucide icon of that
 * name, the drawing the app shows too.
 */
export function sprite(names, { readLucide }) {
  const symbols = [...new Set(names)].sort().map((name) => {
    const mjs = readLucide(name);
    if (mjs == null) {
      throw new Error(`icon "${name}": not a Lucide icon`);
    }
    const body = lucideNodes(mjs)
      .map(({ tag, attrs }) => `<${tag} ${attrs.map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(" ")}/>`)
      .join("");
    return `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`;
  });
  return (
    "<!-- Icons: Lucide icons (ISC License, Copyright (c) Lucide Icons and Contributors). -->\n" +
    `<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">${symbols.join("")}</svg>`
  );
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The output folder as an absolute path, after checking that replacing it cannot delete
 * work: not the repository or an ancestor; inside the repository only tmp/site and the
 * tests' tmp/site-test-*; and only an empty folder or a previous build.
 */
export function assertSafeOut(out, root) {
  const target = path.resolve(out);
  const repo = path.resolve(root);
  if (within(target, repo)) {
    throw new Error(`refusing to replace ${target}: it holds the repository`);
  }
  if (within(repo, target)) {
    const [first, second, ...rest] = path.relative(repo, target).split(path.sep);
    const allowed =
      first === "tmp" &&
      rest.length === 0 &&
      (second === "site" || (second ?? "").startsWith("site-test-"));
    if (!allowed) {
      throw new Error(
        `refusing to replace ${target}: inside the repository only tmp/site may be replaced`,
      );
    }
  }
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) {
      throw new Error(`refusing to replace ${target}: it is not a folder`);
    }
    const entries = fs.readdirSync(target);
    const previousBuild = entries.includes("index.html") && entries.includes("tokens.css");
    if (entries.length > 0 && !previousBuild) {
      throw new Error(`refusing to replace ${target}: it is not empty and holds no previous build`);
    }
  }
  return target;
}

// Files under dir as "/"-separated relative paths, skipping dotfiles; a symbolic link
// is an error, since the Pages artifact must not contain one.
function listFiles(dir, prefix = "") {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`site/${rel}: symbolic links are not allowed`);
    if (stat.isDirectory()) files.push(...listFiles(full, rel));
    else if (stat.isFile()) files.push(rel);
  }
  return files;
}

/**
 * Renders site/ for a parsed release into out: every .html file is a page template, the
 * other files are copied. Everything is read and rendered first; the folder is replaced
 * only when all of it succeeded.
 */
export function build({ release, out, root }) {
  const target = assertSafeOut(out, root);
  const siteDir = path.join(root, "site");
  const files = new Map();
  const pages = new Map();
  for (const rel of listFiles(siteDir)) {
    const data = fs.readFileSync(path.join(siteDir, ...rel.split("/")));
    if (rel.endsWith(".html")) pages.set(rel, data.toString("utf8"));
    else files.set(rel, data);
  }
  if (!pages.has("index.html")) throw new Error("site/index.html not found");
  const images = {};
  for (const [rel, data] of files) {
    const m = /^images\/([a-z0-9-]+\.png)$/.exec(rel);
    if (m) images[m[1]] = pngSize(data);
  }
  const icons = path.join(root, "ui", "node_modules", "lucide-react", "dist", "esm", "icons");
  const readLucide = (name) => {
    const file = path.join(icons, `${name}.mjs`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  for (const [rel, template] of pages) {
    const names = [...template.matchAll(/href="#i-([a-z0-9-]+)"/g)].map((m) => m[1]);
    const base = "../".repeat(rel.split("/").length - 1);
    const symbols = sprite(names, { readLucide });
    files.set(rel, render(template, { release, images, sprite: symbols, base, page: rel }));
  }
  files.set("tokens.css", fs.readFileSync(path.join(root, "ui", "src", "design", "tinyorbit.css")));
  files.set("icon.svg", fs.readFileSync(path.join(root, "assets", "icon.svg")));
  for (const [pkg, file] of FONTS) {
    const source = path.join(root, "ui", "node_modules", "@fontsource", pkg, "files", file);
    if (!fs.existsSync(source)) throw new Error(`font not found: ${source} (run pnpm install)`);
    files.set(`fonts/${file}`, fs.readFileSync(source));
  }
  fs.rmSync(target, { recursive: true, force: true });
  for (const [rel, data] of files) {
    const dest = path.join(target, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return target;
}

function parseArgs(argv) {
  const args = { out: undefined, releaseJson: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--release-json") args.releaseJson = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}\n${USAGE}`);
  }
  if (!args.out) throw new Error(USAGE);
  return args;
}

function fetchLatestRelease() {
  const repo = process.env.GITHUB_REPOSITORY || "tinyorbitvn/skopos-ide";
  try {
    const text = execFileSync("gh", ["api", `repos/${repo}/releases/latest`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `could not read the latest release of ${repo} with gh: ${String(err.stderr || err.message).trim()}`,
    );
  }
}

/** The command line: reads and checks the release, then builds. */
export function cli(argv, { root = ROOT, fetchRelease = fetchLatestRelease } = {}) {
  const args = parseArgs(argv);
  const json = args.releaseJson
    ? JSON.parse(fs.readFileSync(path.resolve(args.releaseJson), "utf8"))
    : fetchRelease();
  const release = parseRelease(json);
  const out = build({ release, out: args.out, root });
  return { release, out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { release, out } = cli(process.argv.slice(2));
    console.log(`build-site: ${release.tag} built into ${out}`);
  } catch (err) {
    console.error(`build-site: ${err.message}`);
    process.exitCode = 1;
  }
}
