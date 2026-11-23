import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSbom,
  checkBom,
  cli,
  integrityHex,
  joinRust,
  lockIntegrity,
  npmLicenses,
  npmPurl,
  TARGET_PROPERTY,
  TARGETS,
  uiComponents,
  uiPackages,
} from "./sbom.mjs";

const ROOT_REF = "path+file:///w/crates/skopos-app#0.12.1";
const ref = (component) => component["bom-ref"];
const crate = (name, version, extra = {}) => ({
  type: "library",
  "bom-ref": `registry+https://github.com/rust-lang/crates.io-index#${name}@${version}`,
  name,
  version,
  scope: "required",
  licenses: [{ expression: "MIT" }],
  purl: `pkg:cargo/${name}@${version}`,
  ...extra,
});
const serde = crate("serde", "1.0.229");
const cc = crate("cc", "1.2.0", { scope: "excluded" });
const windowsSys = crate("windows-sys", "0.61.0");

/** A cargo-cyclonedx 0.5.10 BOM of skopos-app for one target. */
function rustBom(target, components) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    metadata: {
      timestamp: "2026-11-23T00:00:00Z",
      tools: [{ vendor: "CycloneDX", name: "cargo-cyclonedx", version: "0.5.10" }],
      component: {
        type: "application",
        "bom-ref": ROOT_REF,
        name: "skopos-app",
        version: "0.12.1",
        scope: "required",
        purl: "pkg:cargo/skopos-app@0.12.1?download_url=file://.",
        components: [
          {
            type: "library",
            "bom-ref": `${ROOT_REF} bin-target-0`,
            name: "skopos_app_lib",
            version: "0.12.1",
          },
        ],
      },
      properties: [{ name: "cdx:rustc:sbom:target:triple", value: target }],
    },
    components,
    dependencies: [
      { ref: ROOT_REF, dependsOn: components.map(ref) },
      ...components.map((c) => ({ ref: ref(c), dependsOn: [] })),
    ],
  };
}

function fourTargets(overrides = {}) {
  return TARGETS.map((target) => ({
    target,
    bom: overrides[target] ?? rustBom(target, [serde, cc]),
  }));
}

const targetsOf = (component) =>
  component.properties.filter((p) => p.name === TARGET_PROPERTY).map((p) => p.value);

const sha512 = (byte) => `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
const LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  ui:",
  "    dependencies:",
  "      react:",
  "        specifier: ~19.3.0",
  "        version: 19.3.1",
  "",
  "packages:",
  "",
  "  '@radix-ui/primitive@1.1.3':",
  `    resolution: {integrity: ${sha512(3)}}`,
  "",
  "  '@radix-ui/react-dialog@1.3.1':",
  `    resolution: {integrity: ${sha512(1)}}`,
  "    peerDependencies:",
  "      react: '*'",
  "",
  "  '@radix-ui/react-tabs@1.2.0':",
  `    resolution: {integrity: ${sha512(4)}}`,
  "",
  "  react@19.3.1:",
  `    resolution: {integrity: ${sha512(2)}}`,
  "    engines: {node: '>=0.10.0'}",
  "",
  "  real-name@2.0.0:",
  `    resolution: {integrity: ${sha512(5)}}`,
  "",
  "snapshots:",
  "",
  "  react@19.3.1: {}",
  "",
].join("\n");

const registry = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
const node = (name, version, extra = {}) => ({
  from: name,
  version,
  resolved: registry(name, version),
  path: `/w/nm/${name}`,
  ...extra,
});
/** `pnpm list --prod --depth Infinity --json` for ui, with a deduped copy and an alias. */
const LIST = [
  {
    name: "skopos-ui",
    version: "0.12.1",
    path: "/w/ui",
    private: true,
    dependencies: {
      "@radix-ui/react-tabs": node("@radix-ui/react-tabs", "1.2.0", {
        dependencies: {
          "@radix-ui/primitive": node("@radix-ui/primitive", "1.1.3", { deduped: true }),
        },
      }),
      "@radix-ui/react-dialog": node("@radix-ui/react-dialog", "1.3.1", {
        dependencies: {
          "@radix-ui/primitive": node("@radix-ui/primitive", "1.1.3", {
            dependencies: { react: node("react", "19.3.1") },
          }),
        },
      }),
      react: node("react", "19.3.1"),
      "my-alias": node("real-name", "2.0.0"),
    },
  },
];

test("the Rust BOMs join into one component per crate, tagged with its targets", () => {
  const rust = joinRust(
    fourTargets({
      "x86_64-pc-windows-msvc": rustBom("x86_64-pc-windows-msvc", [serde, cc, windowsSys]),
    }),
  );
  const byName = Object.fromEntries(rust.components.map((c) => [c.name, c]));
  assert.deepEqual(targetsOf(byName.serde), TARGETS);
  assert.deepEqual(targetsOf(byName["windows-sys"]), ["x86_64-pc-windows-msvc"]);
  assert.deepEqual(
    [...rust.dependencies.get(ROOT_REF)].sort(),
    [ref(cc), ref(serde), ref(windowsSys)].sort(),
  );
  assert.deepEqual(
    rust.properties.map((p) => p.value),
    TARGETS,
  );
  assert.deepEqual(rust.tools, [
    { type: "application", publisher: "CycloneDX", name: "cargo-cyclonedx", version: "0.5.10" },
  ]);
});

test("a crate one target only builds with and another ships is shipped", () => {
  const rust = joinRust(
    fourTargets({
      "x86_64-pc-windows-msvc": rustBom("x86_64-pc-windows-msvc", [
        serde,
        { ...cc, scope: "required" },
      ]),
    }),
  );
  const joined = rust.components.find((c) => c.name === "cc");
  assert.equal(joined.scope, "required");
  assert.deepEqual(targetsOf(joined), TARGETS);
  const buildOnly = joinRust(fourTargets()).components.find((c) => c.name === "cc");
  assert.equal(buildOnly.scope, "excluded");
});

test("the Rust BOMs must be one per release target and describe the same app", () => {
  assert.throws(() => joinRust(fourTargets().slice(0, 3)), /one BOM for each of/);
  const twice = fourTargets();
  twice[3] = { ...twice[3], target: TARGETS[0] };
  assert.throws(() => joinRust(twice), /one BOM for each of/);
  const other = rustBom(TARGETS[1], [serde]);
  other.metadata.component = { ...other.metadata.component, "bom-ref": "path+file:///w/x#1" };
  assert.throws(() => joinRust(fourTargets({ [TARGETS[1]]: other })), /describes/);
  const changed = rustBom(TARGETS[2], [{ ...serde, description: "changed" }, cc]);
  assert.throws(
    () => joinRust(fourTargets({ [TARGETS[2]]: changed })),
    /differs between targets/,
  );
});

test("npm package URLs percent-encode the scope's @", () => {
  assert.equal(
    npmPurl("@radix-ui/react-dialog", "1.3.1"),
    "pkg:npm/%40radix-ui/react-dialog@1.3.1",
  );
  assert.equal(npmPurl("react", "19.3.1"), "pkg:npm/react@19.3.1");
  assert.equal(npmPurl("x", "1.0.0+build.1"), "pkg:npm/x@1.0.0%2Bbuild.1");
});

test("the lock file gives each package's SHA-512 as hex", () => {
  const integrity = lockIntegrity(LOCK);
  assert.equal(integrity.size, 5);
  assert.equal(integrityHex(integrity.get("react@19.3.1")), "02".repeat(64));
  assert.equal(integrityHex(integrity.get("@radix-ui/react-dialog@1.3.1")), "01".repeat(64));
  assert.equal(integrityHex("sha1-abc"), undefined);
  assert.equal(integrityHex(undefined), undefined);
  assert.equal(lockIntegrity(LOCK.replaceAll("\n", "\r\n")).size, 5);
});

test("licenses become one SPDX expression, and other text a named license", () => {
  assert.deepEqual(npmLicenses({ license: "MIT" }), [{ expression: "MIT" }]);
  assert.deepEqual(npmLicenses({ license: "(MPL-2.0 OR Apache-2.0)" }), [
    { expression: "(MPL-2.0 OR Apache-2.0)" },
  ]);
  assert.deepEqual(npmLicenses({ license: { type: "ISC" } }), [{ expression: "ISC" }]);
  assert.deepEqual(npmLicenses({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }), [
    { expression: "(MIT) OR (Apache-2.0)" },
  ]);
  assert.deepEqual(npmLicenses({ license: "SEE LICENSE IN LICENSE.md" }), [
    { license: { name: "SEE LICENSE IN LICENSE.md" } },
  ]);
  assert.equal(npmLicenses({}), undefined);
});

test("each npm package appears once, with the dependencies of all its copies", () => {
  const ui = uiPackages(LIST);
  assert.deepEqual(ui.direct, [
    npmPurl("@radix-ui/react-tabs", "1.2.0"),
    npmPurl("@radix-ui/react-dialog", "1.3.1"),
    npmPurl("react", "19.3.1"),
    npmPurl("real-name", "2.0.0"),
  ]);
  assert.equal(ui.packages.size, 5);
  const primitive = ui.packages.get(npmPurl("@radix-ui/primitive", "1.1.3"));
  assert.deepEqual([...primitive.dependsOn], [npmPurl("react", "19.3.1")]);
  assert.equal(ui.packages.get(npmPurl("real-name", "2.0.0")).name, "real-name");
});

test("a package not from the registry, or other pnpm output, is refused", () => {
  const linked = structuredClone(LIST);
  linked[0].dependencies.local = { from: "local", version: "link:../local", path: "/w/local" };
  assert.throws(() => uiPackages(linked), /local link:\.\.\/local is not a registry package/);
  assert.throws(() => uiPackages([]), /exactly one project/);
});

test("npm components carry group, purl, licenses, hash and tarball", () => {
  const ui = uiPackages(LIST);
  const components = uiComponents(ui, lockIntegrity(LOCK), () => ({ license: "MIT" }));
  assert.deepEqual(
    components.find((c) => c.name === "react-dialog"),
    {
      type: "library",
      "bom-ref": "pkg:npm/%40radix-ui/react-dialog@1.3.1",
      group: "@radix-ui",
      name: "react-dialog",
      version: "1.3.1",
      licenses: [{ expression: "MIT" }],
      purl: "pkg:npm/%40radix-ui/react-dialog@1.3.1",
      hashes: [{ alg: "SHA-512", content: "01".repeat(64) }],
      externalReferences: [
        {
          type: "distribution",
          url: "https://registry.npmjs.org/@radix-ui/react-dialog/-/react-dialog-1.3.1.tgz",
        },
      ],
    },
  );
  assert.equal(components.find((c) => c.name === "react").group, undefined);
  assert.throws(
    () => uiComponents(ui, new Map(), () => ({})),
    /pnpm-lock\.yaml has no SHA-512 for @radix-ui\/react-tabs@1\.2\.0/,
  );
});

test("the SBOM joins both parts under the app and every reference resolves", () => {
  const rust = joinRust(fourTargets());
  const ui = uiPackages(LIST);
  const bom = buildSbom({
    rust,
    ui,
    npmComponents: uiComponents(ui, lockIntegrity(LOCK), () => ({ license: "MIT" })),
    now: new Date("2026-11-23T10:00:00.123Z"),
    serial: "11111111-2222-4333-8444-555555555555",
  });
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  assert.equal(bom.serialNumber, "urn:uuid:11111111-2222-4333-8444-555555555555");
  assert.equal(bom.metadata.timestamp, "2026-11-23T10:00:00Z");
  assert.equal(bom.metadata.component["bom-ref"], ROOT_REF);
  assert.deepEqual(
    bom.metadata.tools.components.map((t) => t.name),
    ["cargo-cyclonedx", "scripts/sbom.mjs"],
  );
  const root = bom.dependencies.find((d) => d.ref === ROOT_REF);
  for (const purl of ui.direct) assert.ok(root.dependsOn.includes(purl), purl);
  assert.equal(bom.components.length, 2 + 5);
  const refs = bom.components.map(ref);
  assert.deepEqual(refs, [...refs].sort());
  checkBom(bom);
});

test("a repeated bom-ref or a dependency on a missing component is refused", () => {
  const bom = {
    metadata: { component: { "bom-ref": "root" } },
    components: [{ "bom-ref": "a" }, { "bom-ref": "a" }],
    dependencies: [{ ref: "root", dependsOn: ["a", "b"] }],
  };
  assert.throws(() => checkBom(bom), /a appears twice.*root depends on b, which is not a component/);
});

test("merge writes the SBOM from files and names what it wrote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbom-"));
  const rustArgs = fourTargets().flatMap(({ target, bom }) => {
    const file = path.join(dir, `${target}.json`);
    fs.writeFileSync(file, JSON.stringify(bom));
    return ["--rust", `${target}=${file}`];
  });
  fs.writeFileSync(path.join(dir, "ui.json"), JSON.stringify(LIST));
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), LOCK);
  const out = path.join(dir, "SkoposIDE.cdx.json");
  const message = cli(
    [
      "merge",
      ...rustArgs,
      "--ui",
      path.join(dir, "ui.json"),
      "--lock",
      path.join(dir, "pnpm-lock.yaml"),
      "--out",
      out,
    ],
    { readManifest: () => ({ license: "MIT" }) },
  );
  assert.equal(message, `wrote ${out}: 2 crates, 5 npm packages`);
  const bom = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(bom.components.length, 7);
  assert.throws(() => cli(["merge", "--rust", "nofile"]), /usage: node scripts\/sbom\.mjs merge/);
  assert.throws(
    () =>
      cli([
        "merge",
        "--rust",
        "nofile",
        "--ui",
        "u",
        "--lock",
        "l",
        "--out",
        "o",
      ]),
    /--rust takes <target>=<file>, not nofile/,
  );
});
