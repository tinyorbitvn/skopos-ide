import { expect, test } from "vitest";
import { CSS_FILES, declaredNames, themeTokens, varNames } from "../test/css";

// Names from the token file this restyle replaced (spec §4.3).
const OLD = new Set([
  "--bg",
  "--surface",
  "--surface-2",
  "--border",
  "--text",
  "--text-muted",
  "--accent",
  "--accent-2",
  "--ok",
  "--warn",
  "--danger",
  "--info",
  "--radius",
  "--font-ui",
  "--font-size",
  "--shadow-overlay",
  "--overlay-scrim",
  "--on-accent",
]);
// Set at run time: by Radix on its popovers, and by the VirtualTable and OverviewTable inline styles.
const RUNTIME = [
  "--vt-columns",
  "--vt-min-width",
  "--ot-columns",
  "--ot-min-width",
];
const RUNTIME_PREFIX = "--radix-";

// What every stylesheet may use: the tokens, the base layer and the run-time names.
// Anything else must be defined in the same file (spec §8).
const shared = new Set([
  ...declaredNames(CSS_FILES["/src/design/tinyorbit.css"] ?? ""),
  ...declaredNames(CSS_FILES["/src/design/global.css"] ?? ""),
  ...RUNTIME,
]);

test("the old token file is gone and the TinyOrbit one is loaded", () => {
  expect(Object.keys(CSS_FILES)).not.toContain("/src/design/tokens.css");
  expect(CSS_FILES["/src/design/global.css"]).toContain(
    '@import "./tinyorbit.css";',
  );
});

test.each(Object.entries(CSS_FILES))("%s uses no old token name", (_, css) => {
  const used = [...varNames(css), ...declaredNames(css)];
  expect(used.filter((n) => OLD.has(n))).toEqual([]);
});

test.each(Object.entries(CSS_FILES))(
  "%s uses only custom properties that are defined",
  (_, css) => {
    const own = new Set(declaredNames(css));
    const missing = varNames(css).filter(
      (n) => !shared.has(n) && !own.has(n) && !n.startsWith(RUNTIME_PREFIX),
    );
    expect(missing).toEqual([]);
  },
);

test.each(Object.entries(CSS_FILES))(
  "%s loads nothing from a network and draws no gradient but a flat tint",
  (_, css) => {
    expect(css).not.toMatch(/@import\s+url\(\s*["']?https?:/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    // `linear-gradient(var(--x), var(--x))` is one flat colour over a base (spec H68).
    const flat = css.replace(
      /linear-gradient\(\s*(var\(--[a-z-]+\)),\s*\1\s*\)/g,
      "",
    );
    expect(flat).not.toMatch(/gradient\(/);
  },
);

// The board frosts its wallpaper under the column; the app has none, so --glass-backdrop is that
// frosted wallpaper averaged over the column, and the tint is the board's own 84% of sunken over it.
test("the glass tokens hold the design's values in both themes (spec Q §1)", () => {
  const expected = {
    light: {
      "--glass-backdrop": "#b2ceff",
      "--side-selected": "rgba(11, 14, 18, 0.08)",
      "--glass-field": "rgba(255, 255, 255, 0.55)",
      "--tree-line": "#b4bdc8",
    },
    dark: {
      "--glass-backdrop": "#011b59",
      "--side-selected": "rgba(255, 255, 255, 0.13)",
      "--glass-field": "rgba(255, 255, 255, 0.06)",
      "--tree-line": "rgba(255, 255, 255, 0.22)",
    },
  } as const;
  for (const theme of ["light", "dark"] as const) {
    const tokens = themeTokens(theme);
    expect([theme, tokens.get("--glass-tint")]).toEqual([
      theme,
      `color-mix(in srgb, ${tokens.get("--surface-sunken")} 84%, ${tokens.get("--glass-backdrop")})`,
    ]);
    for (const [name, value] of Object.entries(expected[theme])) {
      expect([theme, name, tokens.get(name)]).toEqual([theme, name, value]);
    }
  }
});
