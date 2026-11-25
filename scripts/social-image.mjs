// Renders the project site's link preview card, scripts/social-card.html, into the 1200 x 630
// PNG that the pages name in og:image and twitter:image (site/social-card.png), in headless
// Chrome or Chromium. The card loads the site's own tokens, styles, ribbon, fonts, icon and
// pictures from the repository, at the paths the built site serves them.
// Usage: node scripts/social-image.mjs [--out <file>]
// See docs/releasing.md, "Project site".

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONTS, pngSize } from "./build-site.mjs";
import { connect, evaluate, findChrome, launchChrome } from "./canvas-screens.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/social-image.mjs [--out <file>]";
/** The card's size, the one link previews ask for (1.91:1). */
export const CARD = { width: 1200, height: 630 };
/** Where the site keeps the card, and so the default output. */
export const OUT = "site/social-card.png";
/** Above this a preview may not load on a slow link; the build test holds the PNG to it. */
export const MAX_BYTES = 300 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function parseArgs(argv) {
  const args = { out: OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}\n${USAGE}`);
  }
  return args;
}

/** The files the card may load, by the path it loads them at, as in the built site. */
export function cardFiles(root = ROOT) {
  const files = new Map([
    ["card.html", path.join(root, "scripts", "social-card.html")],
    ["tokens.css", path.join(root, "ui", "src", "design", "tinyorbit.css")],
    ["site.css", path.join(root, "site", "site.css")],
    ["ribbon.js", path.join(root, "site", "ribbon.js")],
    ["icon.svg", path.join(root, "assets", "icon.svg")],
  ]);
  for (const [pkg, file] of FONTS) {
    files.set(`fonts/${file}`, path.join(root, "ui", "node_modules", "@fontsource", pkg, "files", file));
  }
  const images = path.join(root, "site", "images");
  for (const file of fs.readdirSync(images)) files.set(`images/${file}`, path.join(images, file));
  return files;
}

/** The paths the card's markup loads, from its src and href attributes. */
export function cardRefs(html) {
  return [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
}

/** The card's references that cardFiles does not serve, or whose file is missing. */
export function missingRefs(root = ROOT) {
  const files = cardFiles(root);
  const html = fs.readFileSync(files.get("card.html"), "utf8");
  const fonts = [...files.keys()].filter((rel) => rel.startsWith("fonts/"));
  return [...cardRefs(html), ...fonts].filter((rel) => !files.has(rel) || !fs.existsSync(files.get(rel)));
}

function serve(files) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/+/, "");
    const file = files.get(rel);
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function capture(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...CARD, deviceScaleFactor: 1, mobile: false }, sessionId);
  // Under reduced motion ribbon.js draws one still frame, so every render is the same.
  await cdp.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
    sessionId,
  );
  await cdp.send("Page.navigate", { url }, sessionId);
  await evaluate(
    cdp,
    sessionId,
    `new Promise((resolve, reject) => {
      const end = Date.now() + 20000;
      const tick = () => {
        const ready = document.readyState === "complete" && [...document.images].every((img) => img.complete);
        if (ready) resolve();
        else if (Date.now() > end) reject(new Error("the card did not load"));
        else setTimeout(tick, 100);
      };
      tick();
    })`,
  );
  await evaluate(cdp, sessionId, "document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 500)))");
  const state = await evaluate(
    cdp,
    sessionId,
    `({
      fonts: document.fonts.check('600 54px "Manrope"') && document.fonts.check('400 17px "JetBrains Mono"'),
      images: [...document.images].every((img) => img.naturalWidth > 0),
      ribbon: getComputedStyle(document.querySelector("canvas[data-ribbon]")).display !== "none",
      size: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    })`,
  );
  if (!state.fonts) throw new Error("the site's fonts did not load");
  if (!state.images) throw new Error("an image of the card did not load");
  if (!state.ribbon) console.warn("social-image: the ribbon did not draw (no WebGL); the glow shows instead");
  const clip = { x: 0, y: 0, ...CARD, scale: 1 };
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip }, sessionId);
  await cdp.send("Target.closeTarget", { targetId });
  return Buffer.from(data, "base64");
}

/** Renders the card and writes it to out; returns its size in bytes. */
export async function run({ out }) {
  const missing = missingRefs();
  if (missing.length > 0) {
    throw new Error(`the card needs files that are missing:\n  ${missing.join("\n  ")}\n(run pnpm install)`);
  }
  const server = await serve(cardFiles());
  fs.mkdirSync(path.join(ROOT, "tmp"), { recursive: true });
  const profile = fs.mkdtempSync(path.join(ROOT, "tmp", "social-image-profile-"));
  const chrome = launchChrome(findChrome(), profile);
  let cdp;
  try {
    cdp = await connect(await chrome.ws);
    const png = await capture(cdp, `http://127.0.0.1:${server.address().port}/card.html`);
    const { width, height } = pngSize(png);
    if (width !== CARD.width || height !== CARD.height) {
      throw new Error(`the card rendered at ${width} x ${height}, not ${CARD.width} x ${CARD.height}`);
    }
    const target = path.resolve(ROOT, out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, png);
    return png.length;
  } finally {
    const exited = new Promise((resolve) => {
      if (chrome.child.exitCode !== null) resolve();
      else chrome.child.once("exit", resolve);
    });
    await cdp?.send("Browser.close").catch(() => {});
    cdp?.close();
    const timer = setTimeout(() => chrome.child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const bytes = await run(args);
    console.log(`social-image: wrote ${args.out} (${Math.round(bytes / 1024)} KB)`);
    if (bytes > MAX_BYTES) {
      console.error(`social-image: ${args.out} is over ${MAX_BYTES / 1024} KB; simplify the card`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`social-image: ${err.message}`);
    process.exitCode = 1;
  }
}
