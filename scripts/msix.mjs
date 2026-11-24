#!/usr/bin/env node
// Packs the Windows release exe into an MSIX for the Microsoft Store (Store spec §2).
// The package is unsigned: the Store signs it. scripts/msix-install-check.ps1 tests it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "crates", "skopos-app");
const TEMPLATE = path.join(APP, "msix", "AppxManifest.xml");
const ASSETS = ["StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png"];
const NOTICES = ["LICENSE", "THIRD_PARTY_NOTICES.md"];

export const EXECUTABLE = "SkoposIDE.exe";
export const TEST_IDENTITY = Object.freeze({
  name: "SkoposIDE.Test",
  publisher: "CN=SkoposIDE Test",
  publisherDisplayName: "SkoposIDE Test",
});

/** `x.y.z` to the Store's `x.y.z.0`; pre-releases never reach the Store. */
export function packageVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`the Store takes stable versions only, such as 0.13.1, not "${version}"`);
  }
  return `${version}.0`;
}

export function msixName(version) {
  return `SkoposIDE_${version}_x64.msix`;
}

/** `test`, or a store.json from Partner Center's Product identity page. */
export function readIdentity(source) {
  if (source === "test") return { ...TEST_IDENTITY };
  const identity = JSON.parse(fs.readFileSync(source, "utf8"));
  for (const key of ["name", "publisher", "publisherDisplayName"]) {
    if (typeof identity[key] !== "string" || identity[key].trim() === "") {
      throw new Error(`${source}: ${key} is missing`);
    }
  }
  return {
    name: identity.name,
    publisher: identity.publisher,
    publisherDisplayName: identity.publisherDisplayName,
  };
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function renderManifest(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`the manifest template names an unknown value: ${match}`);
    }
    return escapeXml(values[key]);
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest x64 `makeappx.exe` of the Windows SDK, or `MAKEAPPX`. */
function makeappx() {
  if (process.env.MAKEAPPX) return process.env.MAKEAPPX;
  const bin = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin",
  );
  const versions = fs
    .readdirSync(bin)
    .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => compareVersions(b, a));
  for (const version of versions) {
    const tool = path.join(bin, version, "x64", "makeappx.exe");
    if (fs.existsSync(tool)) return tool;
  }
  throw new Error(`makeappx.exe not found under ${bin}`);
}

function main() {
  const { values: args } = parseArgs({
    options: {
      exe: { type: "string" },
      identity: { type: "string" },
      version: { type: "string" },
      out: { type: "string" },
      "render-only": { type: "boolean", default: false },
    },
  });
  for (const key of ["exe", "identity", "version", "out"]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  const version = packageVersion(args.version);
  const identity = readIdentity(args.identity);
  const layout = path.join(args.out, "layout");
  fs.rmSync(layout, { recursive: true, force: true });
  fs.mkdirSync(path.join(layout, "Assets"), { recursive: true });
  fs.copyFileSync(args.exe, path.join(layout, EXECUTABLE));
  for (const file of NOTICES) fs.copyFileSync(path.join(ROOT, file), path.join(layout, file));
  for (const file of ASSETS) {
    fs.copyFileSync(path.join(APP, "icons", file), path.join(layout, "Assets", file));
  }
  const manifest = renderManifest(fs.readFileSync(TEMPLATE, "utf8"), {
    ...identity,
    version,
    executable: EXECUTABLE,
  });
  fs.writeFileSync(path.join(layout, "AppxManifest.xml"), manifest);
  if (args["render-only"]) return;
  const msix = path.join(args.out, msixName(args.version));
  execFileSync(makeappx(), ["pack", "/o", "/d", layout, "/p", msix], { stdio: "inherit" });
  console.log(msix);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`msix: ${error.message}`);
    process.exit(1);
  }
}
