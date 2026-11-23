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

// The window's wallpaper behind the left column (spec Q §1) is the one gradient: tinyorbit.css
// declares it once, as --glass-wall, and no other stylesheet draws one.
const WALL_DECL = /--glass-wall\s*:[^;]*;/g;

test.each(Object.entries(CSS_FILES))(
  "%s loads nothing from a network and draws no gradient but a flat tint",
  (file, css) => {
    expect(css).not.toMatch(/@import\s+url\(\s*["']?https?:/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    // `linear-gradient(var(--x), var(--x))` is one flat colour over a base (spec H68).
    const flat = (
      file === "/src/design/tinyorbit.css" ? css.replace(WALL_DECL, "") : css
    ).replace(/linear-gradient\(\s*(var\(--[a-z-]+\)),\s*\1\s*\)/g, "");
    expect(flat).not.toMatch(/gradient\(/);
  },
);

// The board's glass, value for value: the left column is 84% of sunken over the desktop
// wallpaper, saturated 1.6 times. The board also blurs it 30 px, which its soft shapes do not
// show (at most 3 of 255 per channel apart), so the app leaves the blur out.
test("the glass tokens hold the board's values in both themes (spec Q §1)", () => {
  const expected = {
    light: {
      "--glass-saturate": "1.6",
      "--wall-base": "#e3eaf7",
      "--wall-1": "rgba(138, 170, 255, 0.85)",
      "--wall-2": "rgba(255, 193, 120, 0.8)",
      "--wall-3": "rgba(5, 42, 112, 0.2)",
      "--wall-4": "rgba(79, 128, 251, 0.42)",
      "--side-selected": "rgba(11, 14, 18, 0.08)",
      "--glass-field": "rgba(255, 255, 255, 0.55)",
      "--tree-line": "#b4bdc8",
    },
    dark: {
      "--glass-saturate": "1.6",
      "--wall-base": "#060a14",
      "--wall-1": "rgba(5, 42, 112, 0.95)",
      "--wall-2": "rgba(245, 130, 11, 0.4)",
      "--wall-3": "rgba(11, 87, 227, 0.5)",
      "--wall-4": "rgba(8, 70, 188, 0.5)",
      "--side-selected": "rgba(255, 255, 255, 0.13)",
      "--glass-field": "rgba(255, 255, 255, 0.06)",
      "--tree-line": "rgba(255, 255, 255, 0.22)",
    },
  } as const;
  for (const theme of ["light", "dark"] as const) {
    const tokens = themeTokens(theme);
    const w = expected[theme];
    expect([theme, tokens.get("--glass-tint")]).toEqual([
      theme,
      `color-mix(in srgb, ${tokens.get("--surface-sunken")} 84%, transparent)`,
    ]);
    expect([theme, tokens.get("--glass-wall")?.replace(/\s+/g, " ")]).toEqual([
      theme,
      [
        `radial-gradient(ellipse 44% 58% at 12% 20%, ${w["--wall-1"]} 0%, ${w["--wall-1"]} 38%, transparent 72%)`,
        `radial-gradient(ellipse 38% 50% at 88% 80%, ${w["--wall-2"]} 0%, ${w["--wall-2"]} 34%, transparent 70%)`,
        `radial-gradient(ellipse 58% 42% at 74% 6%, ${w["--wall-3"]} 0%, ${w["--wall-3"]} 36%, transparent 74%)`,
        `radial-gradient(ellipse 36% 40% at 38% 98%, ${w["--wall-4"]} 0%, ${w["--wall-4"]} 32%, transparent 70%)`,
      ].join(", "),
    ]);
    expect([theme, tokens.has("--glass-backdrop")]).toEqual([theme, false]);
    for (const [name, value] of Object.entries(w)) {
      expect([theme, name, tokens.get(name)]).toEqual([theme, name, value]);
    }
  }
});
