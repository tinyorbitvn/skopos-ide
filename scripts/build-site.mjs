// Builds the project site in site/ into a folder GitHub Pages can serve, with the
// downloads of the latest release filled in.
// Usage: node scripts/build-site.mjs --out <dir> [--release-json <file>]
// See docs/releasing.md, "Project site".

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
 * Fills the page's placeholders:
 *   {{release.version|tag|date|isoDate|url}}, {{asset:<suffix>:name|url|size}},
 *   {{image:<file>.png}} (src, width and height) and {{sprite}}.
 * An unknown key or a placeholder left open is an error.
 */
export function render(template, { release, images, sprite }) {
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
      return `src="images/${match[1]}" width="${width}" height="${height}"`;
    }
    throw new Error(`site/index.html: unknown placeholder {{${key}}}`);
  });
  const open = html.indexOf("{{");
  if (open !== -1) {
    throw new Error(
      `site/index.html: placeholder left open near ${JSON.stringify(html.slice(open, open + 40))}`,
    );
  }
  return html;
}
