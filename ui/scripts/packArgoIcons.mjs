// Packs the Argo logo, which the resource map draws for Argo CD Applications, into path data
// (spec §3.3). Usage, from the repository root: node ui/scripts/packArgoIcons.mjs <out.ts>
// It reads the two CNCF files in ui/src/design/logos/ and packs them as packK8sIcons.mjs
// packs the Kubernetes icons, so a PNG or PDF export draws them too. Shapes and colours are
// not changed.
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pack } from "./packK8sIcons.mjs";

const LOGOS = fileURLToPath(new URL("../src/design/logos/", import.meta.url));
const FILES = { black: "argo-icon-black.svg", white: "argo-icon-white.svg" };

function main() {
  const [out] = process.argv.slice(2);
  if (!out) {
    console.error("usage: node ui/scripts/packArgoIcons.mjs <out.ts>");
    process.exit(2);
  }
  const icons = Object.fromEntries(
    Object.entries(FILES).map(([variant, file]) => [
      variant,
      pack(`${LOGOS}${file}`),
    ]),
  );
  for (const [variant, icon] of Object.entries(icons)) {
    console.error(variant, icon.paths.length);
  }
  writeFileSync(
    out,
    [
      "// The Argo logo, black and white: the CNCF artwork in ui/src/design/logos/, see",
      "// THIRD_PARTY_NOTICES.md. Packed by ui/scripts/packArgoIcons.mjs; do not edit by hand.",
      "",
      'import type { PackedIcon } from "./k8sIcons";',
      "",
      `export const ARGO_ICONS: Readonly<Record<"black" | "white", PackedIcon>> = ${JSON.stringify(icons, null, 2)};`,
      "",
    ].join("\n"),
  );
}

// Packs only when run as a script.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
