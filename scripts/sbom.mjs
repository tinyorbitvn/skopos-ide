// Builds the release SBOM: the cargo-cyclonedx BOMs of skopos-app, one per release
// target, joined with the npm packages the UI bundles (the dependencies of ui), as one
// CycloneDX 1.6 document. `make sbom` runs it and release.yml attaches the result. See
// docs/releasing.md, "SBOM".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The release targets, as in the build matrix of release.yml. */
export const TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
];
/** A crate carries this property once for each target that compiles it. */
export const TARGET_PROPERTY = "skopos:target";

const SCRIPT_TOOL = { type: "application", name: "scripts/sbom.mjs" };
const USAGE =
  "usage: node scripts/sbom.mjs merge --rust <target>=<bom.json> (once per release target) --ui <pnpm-list.json> --lock <pnpm-lock.yaml> --out <file>";
const SPDX_EXPRESSION = /^[A-Za-z0-9.+\-() ]+$/;

const byRef = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const shipped = (component) => component.scope !== "excluded";

/** Two copies of a crate from different targets, ignoring what may differ by target. */
function sameCrate(a, b) {
  const strip = ({ scope, properties, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

/** cargo-cyclonedx writes the deprecated tools array; CycloneDX 1.6 lists components. */
function toolComponents(tools) {
  if (!Array.isArray(tools)) return tools?.components ?? [];
  return tools.map(({ vendor, name, version }) => ({
    type: "application",
    ...(vendor ? { publisher: vendor } : {}),
    name,
    ...(version ? { version } : {}),
  }));
}

/**
 * Joins the per-target BOMs into one component per bom-ref, with a TARGET_PROPERTY for
 * each target that has it, and the union of each dependsOn. A crate that one target only
 * builds with (scope "excluded") and another ships is shipped.
 */
export function joinRust(entries) {
  const given = entries.map((entry) => entry.target).sort();
  if (given.join() !== [...TARGETS].sort().join()) {
    throw new Error(
      `expected one BOM for each of ${TARGETS.join(", ")}; got ${given.join(", ") || "none"}`,
    );
  }
  const root = entries[0].bom.metadata?.component;
  if (!root?.["bom-ref"]) throw new Error("the Rust BOM has no metadata.component");
  const components = new Map();
  const dependencies = new Map();
  const properties = [];
  let tools = [];
  for (const { target, bom } of entries) {
    const described = bom.metadata?.component?.["bom-ref"];
    if (described !== root["bom-ref"]) {
      throw new Error(`the ${target} BOM describes ${described}, not ${root["bom-ref"]}`);
    }
    if (tools.length === 0) tools = toolComponents(bom.metadata.tools);
    properties.push(...(bom.metadata.properties ?? []));
    for (const component of bom.components ?? []) {
      const tag = { name: TARGET_PROPERTY, value: target };
      const seen = components.get(component["bom-ref"]);
      if (!seen) {
        components.set(component["bom-ref"], {
          ...component,
          properties: [...(component.properties ?? []), tag],
        });
        continue;
      }
      if (!sameCrate(seen, component)) {
        throw new Error(`${component["bom-ref"]} differs between targets`);
      }
      seen.properties.push(tag);
      if (!shipped(seen) && shipped(component)) {
        if (component.scope === undefined) delete seen.scope;
        else seen.scope = component.scope;
      }
    }
    for (const { ref, dependsOn = [] } of bom.dependencies ?? []) {
      const set = dependencies.get(ref) ?? new Set();
      for (const child of dependsOn) set.add(child);
      dependencies.set(ref, set);
    }
  }
  return { root, tools, properties, components: [...components.values()], dependencies };
}

/** An npm name split into its scope and the rest. */
export function splitName(name) {
  const match = /^(@[^/]+)\/(.+)$/.exec(name);
  return match ? { group: match[1], bare: match[2] } : { group: undefined, bare: name };
}

/** The package URL of an npm package; the scope's @ is written %40. */
export function npmPurl(name, version) {
  const { group, bare } = splitName(name);
  const scope = group ? `${encodeURIComponent(group)}/` : "";
  return `pkg:npm/${scope}${encodeURIComponent(bare)}@${encodeURIComponent(version)}`;
}

/** Each `name@version` key of pnpm-lock.yaml's packages section, with its integrity. */
export function lockIntegrity(lockText) {
  const integrity = new Map();
  let inPackages = false;
  let key;
  for (const line of lockText.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = line === "packages:";
      key = undefined;
      continue;
    }
    if (!inPackages) continue;
    const keyMatch = /^ {2}'?([^'\s][^']*?)'?:$/.exec(line);
    if (keyMatch) {
      key = keyMatch[1];
      continue;
    }
    const resolution = /^ {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(line);
    if (key && resolution) integrity.set(key, resolution[1]);
  }
  return integrity;
}

/** The hex SHA-512 of an `sha512-<base64>` integrity string. */
export function integrityHex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) return undefined;
  const hex = Buffer.from(match[1], "base64").toString("hex");
  return hex.length === 128 ? hex : undefined;
}

function licenseEntry(text) {
  return SPDX_EXPRESSION.test(text) && !/^(SEE |UNLICENSED$)/i.test(text)
    ? { expression: text }
    : { license: { name: text } };
}

/** CycloneDX licenses from a package.json: one SPDX expression, or a named license. */
export function npmLicenses(manifest) {
  const raw = manifest?.license ?? manifest?.licenses;
  const ids = (Array.isArray(raw) ? raw : [raw])
    .map((item) => (typeof item === "string" ? item : item?.type))
    .filter((item) => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
  if (ids.length === 0) return undefined;
  if (ids.length === 1) return [licenseEntry(ids[0])];
  return [licenseEntry(ids.map((id) => `(${id})`).join(" OR "))];
}

/**
 * The packages under one project's dependencies in `pnpm list --prod --depth Infinity
 * --json` output, by package URL. pnpm prints a repeated subtree once and marks the other
 * copies `deduped`, so each package's dependsOn is the union over its copies. An aliased
 * dependency is recorded under the package it installs (`from`).
 */
export function uiPackages(list) {
  if (!Array.isArray(list) || list.length !== 1) {
    throw new Error("expected pnpm list output for exactly one project (ui)");
  }
  const packages = new Map();
  const visit = (dependencies) => {
    const purls = [];
    for (const [key, node] of Object.entries(dependencies ?? {})) {
      const name = node.from ?? key;
      if (!node.resolved || !/^\d/.test(node.version ?? "")) {
        throw new Error(
          `${name} ${node.version} is not a registry package; the SBOM covers registry packages only`,
        );
      }
      const purl = npmPurl(name, node.version);
      purls.push(purl);
      let entry = packages.get(purl);
      if (!entry) {
        entry = {
          name,
          version: node.version,
          resolved: node.resolved,
          path: node.path,
          purl,
          dependsOn: new Set(),
        };
        packages.set(purl, entry);
      }
      for (const child of visit(node.dependencies)) entry.dependsOn.add(child);
    }
    return purls;
  };
  const direct = visit(list[0].dependencies);
  return { direct, packages };
}

function readPackageJson(dir) {
  const file = path.join(dir, "package.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${file} (run pnpm install): ${err.message}`);
  }
}

/** CycloneDX components for the UI's packages; readManifest(dir) gives a package.json. */
export function uiComponents(ui, integrity, readManifest = readPackageJson) {
  return [...ui.packages.values()].map((pkg) => {
    const hex = integrityHex(integrity.get(`${pkg.name}@${pkg.version}`));
    if (!hex) {
      throw new Error(`pnpm-lock.yaml has no SHA-512 for ${pkg.name}@${pkg.version}`);
    }
    const { group, bare } = splitName(pkg.name);
    const licenses = npmLicenses(readManifest(pkg.path));
    return {
      type: "library",
      "bom-ref": pkg.purl,
      ...(group ? { group } : {}),
      name: bare,
      version: pkg.version,
      ...(licenses ? { licenses } : {}),
      purl: pkg.purl,
      hashes: [{ alg: "SHA-512", content: hex }],
      externalReferences: [{ type: "distribution", url: pkg.resolved }],
    };
  });
}

/** Throws when a bom-ref repeats or a dependency names a component the BOM lacks. */
export function checkBom(bom) {
  const refs = new Set();
  const problems = [];
  const add = (component) => {
    const ref = component["bom-ref"];
    if (refs.has(ref)) problems.push(`${ref} appears twice`);
    refs.add(ref);
    for (const child of component.components ?? []) add(child);
  };
  add(bom.metadata.component);
  for (const component of bom.components) add(component);
  for (const { ref, dependsOn = [] } of bom.dependencies) {
    if (!refs.has(ref)) problems.push(`dependency ${ref} is not a component`);
    for (const child of dependsOn) {
      if (!refs.has(child)) problems.push(`${ref} depends on ${child}, which is not a component`);
    }
  }
  if (problems.length > 0) {
    const more = problems.length > 5 ? ` and ${problems.length - 5} more` : "";
    throw new Error(`the SBOM is inconsistent: ${problems.slice(0, 5).join("; ")}${more}`);
  }
}

/**
 * The SBOM: the Rust root describes the app, which also depends on the UI's direct
 * packages. Components and dependencies are sorted so two runs differ only in serial
 * number and time.
 */
export function buildSbom({
  rust,
  ui,
  npmComponents,
  now = new Date(),
  serial = crypto.randomUUID(),
}) {
  const rootRef = rust.root["bom-ref"];
  const dependencies = new Map(
    [...rust.dependencies].map(([ref, set]) => [ref, new Set(set)]),
  );
  const rootDependsOn = dependencies.get(rootRef) ?? new Set();
  for (const purl of ui.direct) rootDependsOn.add(purl);
  dependencies.set(rootRef, rootDependsOn);
  for (const pkg of ui.packages.values()) dependencies.set(pkg.purl, new Set(pkg.dependsOn));
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      tools: { components: [...rust.tools, SCRIPT_TOOL] },
      component: rust.root,
      properties: rust.properties,
    },
    components: [...rust.components, ...npmComponents].sort((a, b) =>
      byRef(a["bom-ref"], b["bom-ref"]),
    ),
    dependencies: [...dependencies]
      .map(([ref, set]) => ({ ref, dependsOn: [...set].sort(byRef) }))
      .sort((a, b) => byRef(a.ref, b.ref)),
  };
  checkBom(bom);
  return bom;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function cli(argv, { readManifest = readPackageJson, now, serial } = {}) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      rust: { type: "string", multiple: true },
      ui: { type: "string" },
      lock: { type: "string" },
      out: { type: "string" },
    },
  });
  if (command !== "merge" || !values.rust || !values.ui || !values.lock || !values.out) {
    throw new Error(USAGE);
  }
  const entries = values.rust.map((arg) => {
    const at = arg.indexOf("=");
    if (at < 1) throw new Error(`--rust takes <target>=<file>, not ${arg}`);
    return { target: arg.slice(0, at), bom: readJson(arg.slice(at + 1)) };
  });
  const rust = joinRust(entries);
  const ui = uiPackages(readJson(values.ui));
  const npmComponents = uiComponents(
    ui,
    lockIntegrity(fs.readFileSync(values.lock, "utf8")),
    readManifest,
  );
  const bom = buildSbom({ rust, ui, npmComponents, now, serial });
  fs.writeFileSync(values.out, `${JSON.stringify(bom, null, 2)}\n`);
  return `wrote ${values.out}: ${rust.components.length} crates, ${ui.packages.size} npm packages`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.error(`sbom: ${cli(process.argv.slice(2))}`);
  } catch (err) {
    console.error(`sbom: ${err.message}`);
    process.exitCode = 1;
  }
}
