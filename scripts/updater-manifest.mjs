// Builds the Tauri updater's latest.json from a draft release's files, and checks a
// published one (in-app update spec §6.3). The publish job of release.yml runs it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const REPO_URL = "https://github.com/vanlongme/skopos-ide";

/**
 * Each platform key of latest.json and the end of its file's name. The plugin looks up
 * `{os}-{arch}-{installer}` first, then `{os}-{arch}`, so a deb install gets the deb and
 * an AppImage the AppImage.
 */
export const PLATFORMS = [
  ["darwin-aarch64-app", "_aarch64.app.tar.gz"],
  ["darwin-aarch64", "_aarch64.app.tar.gz"],
  ["darwin-x86_64-app", "_x64.app.tar.gz"],
  ["darwin-x86_64", "_x64.app.tar.gz"],
  ["linux-x86_64-appimage", "_amd64.AppImage"],
  ["linux-x86_64", "_amd64.AppImage"],
  ["linux-x86_64-deb", "_amd64.deb"],
  ["windows-x86_64-nsis", "_x64-setup.exe"],
  ["windows-x86_64", "_x64-setup.exe"],
];

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const USAGE = [
  "usage: node scripts/updater-manifest.mjs build --version <x.y.z> --notes <file> --assets <file> --sigs <dir> --out <file>",
  "       node scripts/updater-manifest.mjs urls --version <x.y.z> --file <latest.json>",
].join("\n");

/** The asset's download address, pinned to the version. */
export function assetUrl(version, name) {
  return `${REPO_URL}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

/** RFC 3339 in UTC, without milliseconds. */
export function rfc3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * latest.json for `version`. `assets` are the draft's file names; `signatures` maps a file
 * name to the content of its `.sig`. Throws, naming every problem, unless each platform has
 * exactly one file and a signature.
 */
export function buildManifest({ version, notes, pubDate, assets, signatures }) {
  if (!VERSION.test(version)) {
    throw new Error(`version ${JSON.stringify(version)} is not x.y.z`);
  }
  const problems = [];
  const platforms = {};
  for (const [key, suffix] of PLATFORMS) {
    const found = assets.filter((name) => name.endsWith(suffix));
    if (found.length !== 1) {
      problems.push(
        found.length === 0
          ? `${key}: no file ending in ${suffix}`
          : `${key}: ${found.length} files end in ${suffix}: ${found.join(", ")}`,
      );
      continue;
    }
    const [file] = found;
    const signature = (signatures[file] ?? "").trim();
    if (signature === "") {
      problems.push(`${key}: no signature for ${file}`);
      continue;
    }
    platforms[key] = { signature, url: assetUrl(version, file) };
  }
  if (problems.length > 0)
    throw new Error(`latest.json: ${problems.join("; ")}`);
  return { version, notes, pub_date: pubDate, platforms };
}

/** Checks that a published latest.json offers `version` on every platform; its addresses. */
export function manifestUrls(manifest, version) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new Error("latest.json is not an object");
  }
  if (manifest.version !== version) {
    throw new Error(
      `latest.json names ${JSON.stringify(manifest.version)}, not ${version}`,
    );
  }
  const prefix = `${REPO_URL}/releases/download/v${version}/`;
  const urls = new Set();
  for (const [key] of PLATFORMS) {
    const entry = manifest.platforms?.[key];
    if (
      typeof entry?.url !== "string" ||
      typeof entry.signature !== "string" ||
      entry.signature === ""
    ) {
      throw new Error(`latest.json: ${key} is missing`);
    }
    if (!entry.url.startsWith(prefix)) {
      throw new Error(`latest.json: ${key} points at ${entry.url}`);
    }
    urls.add(entry.url);
  }
  return [...urls];
}

/** The content of each `<asset>.sig` in `dir`, keyed by the asset's name. */
export function readSignatures(dir) {
  const signatures = {};
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith(".sig")) {
      signatures[entry.slice(0, -".sig".length)] = fs.readFileSync(
        path.join(dir, entry),
        "utf8",
      );
    }
  }
  return signatures;
}

function required(values, names) {
  for (const name of names) {
    if (typeof values[name] !== "string" || values[name] === "")
      throw new Error(USAGE);
  }
}

/** The command line. `build` returns the path it wrote; `urls` the text it prints. */
export function cli(argv, now = new Date()) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        version: { type: "string" },
        notes: { type: "string" },
        assets: { type: "string" },
        sigs: { type: "string" },
        out: { type: "string" },
        file: { type: "string" },
      },
    }));
  } catch {
    throw new Error(USAGE);
  }
  if (command === "build") {
    required(values, ["version", "notes", "assets", "sigs", "out"]);
    const manifest = buildManifest({
      version: values.version,
      notes: fs.readFileSync(values.notes, "utf8").trim(),
      pubDate: rfc3339(now),
      assets: fs
        .readFileSync(values.assets, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
      signatures: readSignatures(values.sigs),
    });
    fs.writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
    return values.out;
  }
  if (command === "urls") {
    required(values, ["version", "file"]);
    const manifest = JSON.parse(fs.readFileSync(values.file, "utf8"));
    return `${manifestUrls(manifest, values.version).join("\n")}\n`;
  }
  throw new Error(USAGE);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = cli(process.argv.slice(2));
    if (process.argv[2] === "urls") process.stdout.write(result);
    else console.error(`updater-manifest: wrote ${result}`);
  } catch (err) {
    console.error(`updater-manifest: ${err.message}`);
    process.exitCode = 1;
  }
}
