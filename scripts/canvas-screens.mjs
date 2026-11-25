// Captures the project site's feature images from the main board of the SkoposIDE Screens
// design canvas ("Whole application", project/App.dc.html), rendered in headless Chrome.
// Usage: node scripts/canvas-screens.mjs --canvas <dir> --out <dir> [--only <name>,...]
//
// <dir> holds the canvas files at their published paths, as the canvas artifact serves them:
//   project/App.dc.html, project/ds/<system>/..., artifact-type/dc-runtime.js (the board's
//   ./support.js) and _blob/<id>.js for each uploaded script the board loads.
// See docs/releasing.md, "Project site".

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/canvas-screens.mjs --canvas <dir> --out <dir> [--only <name>,...]";
const BOARD = "App.dc.html";
const VIEWPORT = { width: 1360, height: 860 };
// The site shows the feature images at about 0.6 of their CSS size, so 1.25 device pixels
// per CSS pixel stays sharp on a 2x screen.
const SCALE = 1.25;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * The shots, in page order. `steps` runs in the board with the helpers of PAGE_HELPERS;
 * `clip` returns the area to capture: an element, or [element, x, y, width, height] for a
 * part of it in CSS pixels; `scale` overrides SCALE. The hero and Themes pictures show the
 * whole window. The cards of a row share one shape: 980 × 600 for the half cards and
 * 640 × 600 for the third cards.
 */
export const SHOTS = [
  {
    name: "canvas-pods-drawer-dark",
    steps: `await openPodDrawer();`,
    clip: "root()",
  },
  {
    name: "canvas-pods-drawer-light",
    steps: `
      click("Search or run a command");
      await waitFor(() => $(".sk-root [role=dialog] input"));
      typeInto($(".sk-root [role=dialog] input"), "Theme");
      await waitFor(() => has("Theme: Light"));
      clickHas("Theme: Light");
      await waitFor(() => $(".sk-root[data-theme=light]"));
      await sleep(400);
      await openPodDrawer();`,
    clip: "root()",
  },
  {
    name: "canvas-catalog",
    steps: "",
    clip: "[root(), 0, 0, 980, 600]",
  },
  {
    name: "canvas-yaml",
    steps: `
      await openCluster();
      await nav("Workloads", "Deployments");
      await waitFor(() => row("payments-api"));
      clickRow("payments-api");
      await waitFor(() => q("Edit YAML"));
      click("Edit YAML");
      await waitFor(() => has("Deployment enables declarative updates"));
      click("Close details");
      await sleep(600);`,
    clip: `[$(".sh-work"), 0, $(".sh-work").offsetHeight - 626, $(".sh-work").offsetWidth, 626]`,
  },
  {
    name: "canvas-split",
    steps: `
      await openPods();
      click("Split right");
      await waitFor(() => document.querySelectorAll(".sk-root section.sh-pane").length === 2);
      await sleep(400);
      click("Overview");
      await waitFor(() => has("Capacity") && document.querySelectorAll(".sk-root section.sh-pane").length === 2);
      await sleep(1500);`,
    clip: `[$(".sh-work"), 12, 0, $(".sh-work").offsetWidth - 12, $(".sh-work").offsetHeight]`,
  },
  {
    name: "canvas-overview",
    steps: `
      await openCluster();
      await waitFor(() => has("Capacity") && has("Top consumers"));
      await sleep(1200);`,
    clip: `[$("section.sh-pane"), 12, 0, $("section.sh-pane").offsetWidth - 12, ($("section.sh-pane").offsetWidth - 12) * 600 / 980]`,
  },
  {
    name: "canvas-topology",
    steps: `
      await openCluster();
      await nav("Nodes", "Topology");
      await waitFor(() => has("Node topology"));
      await sleep(1200);`,
    clip: `[$("section.sh-pane"), 12, 0, $("section.sh-pane").offsetWidth - 12, ($("section.sh-pane").offsetWidth - 12) * 600 / 980]`,
  },
  {
    name: "canvas-logs",
    steps: `
      await openPodDrawer();
      click("Logs");
      await waitFor(() => $("section.sk-dock [role=log]"));
      click("Close details");
      await sleep(600);`,
    clip: `[$(".sh-work"), 0, $(".sh-work").offsetHeight - 600, 640, 600]`,
  },
  {
    name: "canvas-map",
    steps: `
      await openCluster();
      click("Resource map");
      await waitFor(() => q("Export"));
      await sleep(1200);`,
    clip: `[$("section.sh-pane"), 12, 0, 640, 600]`,
  },
  {
    name: "canvas-metrics",
    steps: `
      await openPodDrawer();
      click("Metrics");
      await sleep(1200);`,
    clip: `[$("aside.sk-drawer"), -220, 0, 640, 600]`,
  },
  {
    name: "canvas-helm",
    steps: `
      await openCluster();
      await nav("Helm", "Releases");
      await waitFor(() => has("Download helm"));
      clickHas("Download helm");
      await waitFor(() => row("ingress-nginx"), 15000);
      for (const b of document.querySelectorAll(".sk-toast button[aria-label=Dismiss]")) b.click();
      await waitFor(() => !has("is ready"));
      await sleep(600);`,
    clip: `[$("section.sh-pane"), 12, 0, $("section.sh-pane").offsetWidth, 292]`,
  },
  {
    name: "canvas-argo",
    steps: `
      await openCluster();
      await nav("Argo", "Argo CD", "Applications");
      await waitFor(() => row("trace-agent"));
      await sleep(600);`,
    clip: `[$("section.sh-pane"), 12, 0, $("section.sh-pane").offsetWidth, 374]`,
  },
  {
    name: "canvas-pods",
    steps: `await openPods();`,
    clip: `[$("section.sh-pane"), 12, 0, 640, 600]`,
  },
  {
    name: "canvas-filter",
    steps: `
      await openPods();
      const box = $(".sk-root input[aria-label^='Filter by any column']") || [...root().querySelectorAll("input")].find((i) => (i.placeholder || "").startsWith("Filter by any column"));
      box.focus();
      typeInto(box, "status != Running");
      await sleep(400);
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitFor(() => !row("kafka-0"));
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      box.blur();
      await sleep(800);`,
    clip: `[$("section.sh-pane"), 12, 0, 640, 600]`,
  },
  {
    name: "canvas-ai",
    steps: `
      await openPods();
      click("Agent (Ctrl+J)");
      await waitFor(() => $("aside.ai-panel .ai-sugg"));
      $("aside.ai-panel .ai-sugg").click();
      await waitFor(() => has("Approve for this chat"), 30000);
      await sleep(800);`,
    // From the work column's left edge to the panel's right edge, in the half cards' shape.
    clip: `(() => {
      const r = root().getBoundingClientRect(), w = $(".sh-work").getBoundingClientRect(), p = $("aside.ai-panel").getBoundingClientRect();
      const width = p.right - w.left - 12;
      return [root(), w.left - r.left + 12, p.top - r.top, width, width * 600 / 980];
    })()`,
  },
  {
    name: "canvas-about",
    steps: `
      click("Search or run a command");
      await waitFor(() => has("About SkoposIDE"));
      clickHas("About SkoposIDE");
      await waitFor(() => $(".sk-root [role=dialog][aria-label='About SkoposIDE']"));
      await sleep(600);`,
    clip: `[$(".sk-root [role=dialog]"), ($(".sk-root [role=dialog]").offsetWidth - 980) / 2, 0, 980, 600]`,
  },
  {
    name: "canvas-palette",
    steps: `
      click("Search or run a command");
      await waitFor(() => $(".sk-root [role=dialog][aria-label='Command palette']"));
      await sleep(600);`,
    clip: `[$(".sk-root [role=dialog]"), -40, 0, 640, 600]`,
  },
  {
    name: "canvas-settings-metrics",
    steps: `
      await openCluster();
      click("Cluster settings");
      await waitFor(metricsHeading);
      [...document.querySelectorAll(".sk-root label")].find((l) => l.textContent.includes("Prometheus or Mimir in the cluster")).click();
      await sleep(600);
      // The click renders the section again, so look the heading up anew.
      metricsHeading().closest("section").scrollIntoView({ block: "center" });
      await sleep(400);`,
    clip: `metricsHeading().closest("section")`,
    scale: 2,
  },
];

/** Finders and actions the shot steps use, run in the board before each shot. */
export const PAGE_HELPERS = String.raw`
const root = () => document.querySelector(".sk-root");
const $ = (selector) => document.querySelector(selector);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim();
function q(name) {
  const els = [...root().querySelectorAll("button, [role=tab], [role=menuitem], [role=option], a")];
  return els.find((el) => label(el) === name) || els.find((el) => label(el).startsWith(name));
}
function click(name) {
  const el = q(name);
  if (!el) throw new Error("no control named " + JSON.stringify(name));
  el.click();
}
function has(text) {
  const all = [...root().querySelectorAll("*")].filter((el) => el.textContent.includes(text));
  return all[all.length - 1] || null;
}
function clickHas(text) {
  const el = has(text);
  if (!el) throw new Error("no element with " + JSON.stringify(text));
  el.click();
}
// Types into a field the way a key press would, so the board's input handler sees it.
function typeInto(input, text) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const row = (text) => [...root().querySelectorAll("[role=row]")].find((r) => r.textContent.includes(text));
function clickRow(text) {
  const r = row(text);
  if (!r) throw new Error("no row with " + JSON.stringify(text));
  (r.querySelector("[role=gridcell]:nth-child(2)") || r).click();
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting for " + fn);
    await sleep(100);
  }
}
async function nav(...names) {
  for (const name of names) {
    await waitFor(() => q(name));
    click(name);
    await sleep(300);
  }
}
const metricsHeading = () =>
  [...root().querySelectorAll("h2, h3")].find((h) => h.textContent.trim() === "Metrics" && h.offsetHeight > 0);
async function openCluster() {
  click("prod-eu-west");
  await waitFor(() => q("Workloads"));
}
async function openPods() {
  await openCluster();
  await nav("Workloads", "Pods");
  await waitFor(() => row("payments-api-7f9c5d-m4v8s"));
}
async function openPodDrawer() {
  await openPods();
  clickRow("payments-api-7f9c5d-m4v8s");
  await waitFor(() => q("Close details"));
  await sleep(800);
}
`;

export function parseArgs(argv) {
  const args = { canvas: undefined, out: undefined, only: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--canvas") args.canvas = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else throw new Error(`unknown argument: ${argv[i]}\n${USAGE}`);
  }
  if (!args.canvas || !args.out) throw new Error(USAGE);
  if (args.only) {
    const names = new Set(SHOTS.map((s) => s.name));
    const unknown = args.only.filter((n) => !names.has(n));
    if (unknown.length > 0) throw new Error(`unknown shot: ${unknown.join(", ")}`);
  }
  return args;
}

/**
 * The file under the canvas folder that serves a request path of the board, or null:
 * /support.js is the runtime, /_blob/<id> an uploaded script, anything else a file under
 * project/. Paths that leave the folder are refused.
 */
export function resolveRequest(canvasDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) return null;
  if (parts.length === 1 && parts[0] === "support.js") {
    return path.join(canvasDir, "artifact-type", "dc-runtime.js");
  }
  if (parts.length === 2 && parts[0] === "_blob" && /^[0-9a-f]{32}$/.test(parts[1])) {
    return path.join(canvasDir, "_blob", `${parts[1]}.js`);
  }
  if (parts.length === 0) return null;
  return path.join(canvasDir, "project", ...parts);
}

export function contentType(file) {
  return TYPES[path.extname(file)] ?? "application/octet-stream";
}

/** The uploaded scripts (/_blob/<id>) a board loads. */
export function blobIds(html) {
  return [...html.matchAll(/<script\s+src="\/_blob\/([0-9a-f]{32})"/g)].map((m) => m[1]);
}

/** The canvas files the board needs that the folder lacks, as published paths. */
export function missingFiles(canvasDir) {
  const board = path.join(canvasDir, "project", BOARD);
  if (!fs.existsSync(board)) return [`project/${BOARD}`];
  const html = fs.readFileSync(board, "utf8");
  const needed = ["artifact-type/dc-runtime.js"];
  for (const m of html.matchAll(/<(?:script|link)\s[^>]*(?:src|href)="(ds\/[^"]+)"/g)) {
    needed.push(`project/${m[1]}`);
  }
  for (const id of blobIds(html)) needed.push(`_blob/${id}.js`);
  return needed.filter((rel) => !fs.existsSync(path.join(canvasDir, ...rel.split("/"))));
}

/** The Chrome or Chromium binary: $CHROME, else the first of the usual names on PATH. */
export function findChrome(env = process.env, exists = fs.existsSync) {
  if (env.CHROME) return env.CHROME;
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (exists(file)) return file;
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (exists(mac)) return mac;
  throw new Error("Chrome or Chromium not found: set CHROME to its binary");
}

function serve(canvasDir) {
  const server = http.createServer((req, res) => {
    const file = resolveRequest(canvasDir, new URL(req.url, "http://localhost").pathname);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const type = file.includes(`${path.sep}_blob${path.sep}`) ? TYPES[".js"] : contentType(file);
    res.writeHead(200, { "content-type": type }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** A DevTools Protocol client over the browser's WebSocket, with flat sessions. */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
  });
  let next = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = msg.id && pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
    else waiter.resolve(msg.result);
  });
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      next += 1;
      pending.set(next, { resolve, reject, method });
      ws.send(JSON.stringify({ id: next, method, params, sessionId }));
    });
  return { send, close: () => ws.close() };
}

export function launchChrome(binary, profile) {
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const ws = new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (m) resolve(m[1]);
    });
    child.on("exit", (code) => reject(new Error(`Chrome exited (${code}) before it listened:\n${log}`)));
  });
  return { child, ws };
}

export async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(detail);
  }
  return result.result.value;
}

async function capture(cdp, boardUrl, shot) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext");
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { ...VIEWPORT, deviceScaleFactor: shot.scale ?? SCALE, mobile: false },
      sessionId,
    );
    // Native dialogs would stop the steps; the board has none on these paths.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.alert = window.confirm = window.prompt = () => undefined;" }, sessionId);
    await cdp.send("Page.navigate", { url: boardUrl }, sessionId);
    await evaluate(
      cdp,
      sessionId,
      `new Promise((resolve, reject) => { const end = Date.now() + 30000; const tick = () => document.querySelector(".sk-root") ? resolve() : Date.now() > end ? reject(new Error("the board did not render")) : setTimeout(tick, 100); tick(); })`,
    );
    await evaluate(cdp, sessionId, "document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 800)))");
    await evaluate(cdp, sessionId, `(async () => { ${PAGE_HELPERS}\n${shot.steps}\n })()`);
    const rect = await evaluate(
      cdp,
      sessionId,
      `(() => { ${PAGE_HELPERS}
        const clip = ${shot.clip};
        const [el, x = 0, y = 0, w, h] = Array.isArray(clip) ? clip : [clip];
        if (!el) throw new Error("nothing to capture");
        const r = el.getBoundingClientRect();
        return { x: r.x + x, y: r.y + y, width: w ?? r.width - x, height: h ?? r.height - y };
      })()`,
    );
    const clip = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(Math.min(rect.width, VIEWPORT.width - Math.max(rect.x, 0))),
      height: Math.round(Math.min(rect.height, VIEWPORT.height - Math.max(rect.y, 0))),
      scale: 1,
    };
    if (clip.width < 100 || clip.height < 100) throw new Error(`clip too small: ${JSON.stringify(clip)}`);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip }, sessionId);
    await cdp.send("Target.closeTarget", { targetId });
    return Buffer.from(data, "base64");
  } finally {
    await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  }
}

/** Renders the board and writes one PNG per shot into out. */
export async function run({ canvas, out, only }) {
  const canvasDir = path.resolve(canvas);
  const missing = missingFiles(canvasDir);
  if (missing.length > 0) {
    throw new Error(
      `the canvas folder ${canvasDir} lacks:\n  ${missing.join("\n  ")}\nsave them from the canvas artifact (see docs/releasing.md)`,
    );
  }
  const shots = only ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  const server = await serve(canvasDir);
  fs.mkdirSync(path.join(ROOT, "tmp"), { recursive: true });
  const profile = fs.mkdtempSync(path.join(ROOT, "tmp", "canvas-screens-profile-"));
  const chrome = launchChrome(findChrome(), profile);
  let cdp;
  try {
    cdp = await connect(await chrome.ws);
    const boardUrl = `http://127.0.0.1:${server.address().port}/${BOARD}`;
    fs.mkdirSync(out, { recursive: true });
    for (const shot of shots) {
      const png = await capture(cdp, boardUrl, shot);
      fs.writeFileSync(path.join(out, `${shot.name}.png`), png);
      console.log(`canvas-screens: ${shot.name}.png`);
    }
  } finally {
    // Browser.close lets Chrome and its helper processes leave the profile before it goes.
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
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`canvas-screens: could not remove ${profile}: ${err.message}`);
    }
  }
  return shots.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = await run(parseArgs(process.argv.slice(2)));
    console.log(`canvas-screens: wrote ${count} images`);
  } catch (err) {
    console.error(`canvas-screens: ${err.message}`);
    process.exitCode = 1;
  }
}
