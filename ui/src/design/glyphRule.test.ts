import { expect, test } from "vitest";
import biomeConfig from "../../../biome.json?raw";
import { GLYPH_EXPORTS } from "./glyphs";

interface RestrictedImports {
  level: string;
  options: {
    paths: Record<string, { importNames: string[]; message: string }>;
  };
}

function rule(): RestrictedImports {
  const config = JSON.parse(biomeConfig) as {
    linter: { rules: { style?: { noRestrictedImports?: RestrictedImports } } };
  };
  const found = config.linter.rules.style?.noRestrictedImports;
  if (found === undefined) throw new Error("noRestrictedImports is not set");
  return found;
}

test("Biome blocks the 27 glyph names from lucide-react, and only them", () => {
  const { level, options } = rule();
  expect(level).toBe("error");
  expect(Object.keys(options.paths)).toEqual(["lucide-react"]);
  const entry = options.paths["lucide-react"];
  expect(entry.importNames).toEqual([...GLYPH_EXPORTS]);
  expect(entry.message).toBe("Use the app's own icon from design/glyphs.");
  // Names that stay on lucide-react must not be listed.
  for (const stays of ["Box", "Copy", "X", "createLucideIcon", "LucideIcon"]) {
    expect(entry.importNames).not.toContain(stays);
  }
});
