import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  blobIds,
  contentType,
  findChrome,
  missingFiles,
  PAGE_HELPERS,
  parseArgs,
  resolveRequest,
  SHOTS,
} from "./canvas-screens.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANVAS = path.join(path.sep, "canvas");
const BLOB = "8d2503accf671f545731a8481befb358";

// A fresh empty folder in the repository's git-ignored tmp/.
function tempDir(t) {
  fs.mkdirSync(path.join(ROOT, "tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, "tmp", "canvas-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, text = "") {
  const file = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const BOARD_HEAD = `<!doctype html>
<html><head>
<script src="./support.js"></script>
<link rel="stylesheet" href="ds/system_1/styles.css">
<script src="ds/system_1/vendor/lucide.min.js"></script>
<script src="ds/system_1/components/bundle.js"></script>
<script src="/_blob/${BLOB}"></script>
</head><body></body></html>`;

describe("parseArgs", () => {
  test("reads the canvas folder, the output folder and the shots to take", () => {
    assert.deepEqual(parseArgs(["--canvas", "tmp/canvas", "--out", "site/images"]), {
      canvas: "tmp/canvas",
      out: "site/images",
      only: undefined,
    });
    assert.deepEqual(
      parseArgs(["--canvas", "c", "--out", "o", "--only", "canvas-map,canvas-pods"]).only,
      ["canvas-map", "canvas-pods"],
    );
  });

  test("stops on a missing folder, an unknown argument or an unknown shot", () => {
    assert.throws(() => parseArgs(["--canvas", "c"]), /usage/);
    assert.throws(() => parseArgs(["--out", "o"]), /usage/);
    assert.throws(() => parseArgs(["--canvas", "c", "--out", "o", "--theme", "light"]), /unknown argument: --theme/);
    assert.throws(() => parseArgs(["--canvas", "c", "--out", "o", "--only", "canvas-nope"]), /unknown shot: canvas-nope/);
  });
});

describe("resolveRequest", () => {
  test("serves the runtime, uploaded scripts and the project's files", () => {
    assert.equal(resolveRequest(CANVAS, "/support.js"), path.join(CANVAS, "artifact-type", "dc-runtime.js"));
    assert.equal(resolveRequest(CANVAS, `/_blob/${BLOB}`), path.join(CANVAS, "_blob", `${BLOB}.js`));
    assert.equal(resolveRequest(CANVAS, "/App.dc.html"), path.join(CANVAS, "project", "App.dc.html"));
    assert.equal(
      resolveRequest(CANVAS, "/ds/system_1/components/bundle.js"),
      path.join(CANVAS, "project", "ds", "system_1", "components", "bundle.js"),
    );
  });

  test("keeps every request inside the canvas folder", () => {
    for (const bad of ["/", "/../secret", "/%2e%2e/secret", "/ds/../../secret", "/a%5Cb", "/a%00b", "/%E0%A4%A"]) {
      assert.equal(resolveRequest(CANVAS, bad), null, bad);
    }
    const other = resolveRequest(CANVAS, "/_blob/not-an-id");
    assert.equal(other, path.join(CANVAS, "project", "_blob", "not-an-id"));
  });
});

test("contentType names the board's file types", () => {
  assert.equal(contentType("App.dc.html"), "text/html; charset=utf-8");
  assert.equal(contentType("bundle.js"), "text/javascript; charset=utf-8");
  assert.equal(contentType("styles.css"), "text/css; charset=utf-8");
  assert.equal(contentType("notes.bin"), "application/octet-stream");
});

test("blobIds lists the uploaded scripts a board loads", () => {
  assert.deepEqual(blobIds(BOARD_HEAD), [BLOB]);
  assert.deepEqual(blobIds('<script src="./support.js"></script>'), []);
});

describe("missingFiles", () => {
  test("names the board when it is missing", (t) => {
    assert.deepEqual(missingFiles(tempDir(t)), ["project/App.dc.html"]);
  });

  test("names the runtime, the design system's files and the uploads the board needs", (t) => {
    const dir = tempDir(t);
    write(dir, "project/App.dc.html", BOARD_HEAD);
    write(dir, "project/ds/system_1/styles.css");
    assert.deepEqual(missingFiles(dir), [
      "artifact-type/dc-runtime.js",
      "project/ds/system_1/vendor/lucide.min.js",
      "project/ds/system_1/components/bundle.js",
      `_blob/${BLOB}.js`,
    ]);
    write(dir, "artifact-type/dc-runtime.js");
    write(dir, "project/ds/system_1/vendor/lucide.min.js");
    write(dir, "project/ds/system_1/components/bundle.js");
    write(dir, `_blob/${BLOB}.js`);
    assert.deepEqual(missingFiles(dir), []);
  });
});

describe("findChrome", () => {
  test("takes CHROME first, then the first known name on PATH", () => {
    assert.equal(findChrome({ CHROME: "/opt/chrome/chrome", PATH: "/usr/bin" }, () => false), "/opt/chrome/chrome");
    const found = new Set([path.join("/usr/bin", "chromium")]);
    assert.equal(
      findChrome({ PATH: ["/usr/local/bin", "/usr/bin"].join(path.delimiter) }, (f) => found.has(f)),
      path.join("/usr/bin", "chromium"),
    );
  });

  test("stops when there is none", () => {
    assert.throws(() => findChrome({ PATH: "/usr/bin" }, () => false), /set CHROME/);
  });
});

describe("SHOTS", () => {
  const names = SHOTS.map((s) => s.name);
  const pages = ["index.html", path.join("docs", "metrics.html")].map((rel) =>
    fs.readFileSync(path.join(ROOT, "site", rel), "utf8"),
  );

  test("names each shot once, as a canvas picture", () => {
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.match(name, /^canvas-[a-z-]+$/);
  });

  test("has a picture in site/images for each shot, and a shot for each canvas picture", () => {
    const images = fs.readdirSync(path.join(ROOT, "site", "images"));
    const canvas = images.filter((f) => f.startsWith("canvas-")).map((f) => f.replace(/\.png$/, ""));
    assert.deepEqual([...canvas].sort(), [...names].sort());
  });

  test("puts each picture on a page of the site", () => {
    for (const name of names) {
      assert.ok(pages.some((html) => html.includes(`{{image:${name}.png}}`)), name);
    }
  });

  test("writes steps and clips the browser can run", () => {
    const AsyncFunction = (async () => {}).constructor;
    for (const shot of SHOTS) {
      assert.doesNotThrow(() => new AsyncFunction(`${PAGE_HELPERS}\n${shot.steps}`), shot.name);
      assert.doesNotThrow(() => new Function(`${PAGE_HELPERS}\nreturn ${shot.clip};`), shot.name);
      if (shot.scale !== undefined) assert.ok(shot.scale >= 1 && shot.scale <= 3, shot.name);
    }
  });
});
