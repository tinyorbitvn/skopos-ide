import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE = fs.readFileSync(path.join(ROOT, "site", "ribbon.js"), "utf8");
const UNIFORMS = ["uAng", "uBg", "uDeep", "uHi", "uMid", "uRes", "uRim", "uTime"];
// The dark page's values of the tokens ribbon.js reads.
const TOKENS = {
  "--gray-950": "#0b0e12",
  "--orbit-800": "#052a70",
  "--orbit-500": "#0b57e3",
  "--orbit-300": "#8aaaff",
  "--orbit-50": "#edf3ff",
};

// ribbon.js runs in its own context, with no document, so it does not start by itself.
function loadRibbon() {
  const context = vm.createContext({});
  vm.runInContext(CODE, context, { filename: "ribbon.js" });
  return context.SkoposRibbon;
}

// Values made in the vm context have that context's prototypes; compare them as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

function listenerBag() {
  const bag = {};
  return {
    addEventListener(type, fn) {
      if (!bag[type]) bag[type] = new Set();
      bag[type].add(fn);
    },
    removeEventListener(type, fn) {
      bag[type]?.delete(fn);
    },
    emit(type) {
      for (const fn of [...(bag[type] ?? [])]) fn({ type });
    },
    count: () => Object.values(bag).reduce((n, set) => n + set.size, 0),
  };
}

// A WebGL 1 context that records what ribbon.js asks of it.
function fakeGl({ compiles = true, links = true } = {}) {
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    draws: 0,
    uniforms: {},
    asked: new Set(),
    createShader: (type) => ({ type }),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => compiles,
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => links,
    useProgram() {},
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    getAttribLocation: () => 0,
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getUniformLocation(_program, name) {
      gl.asked.add(name);
      return name;
    },
    uniform1f(name, value) {
      gl.uniforms[name] = value;
    },
    uniform2f(name, x, y) {
      gl.uniforms[name] = [x, y];
    },
    uniform3fv(name, values) {
      gl.uniforms[name] = [...values];
    },
    viewport() {},
    drawArrays() {
      gl.draws += 1;
    },
  };
  return gl;
}

function fakeCanvas({
  gl = fakeGl(),
  attrs = { "data-ribbon": "" },
  rect = { width: 1440, height: 900 },
  throws = false,
} = {}) {
  const events = listenerBag();
  return {
    gl,
    attrs,
    rect,
    hidden: false,
    width: 300,
    height: 150,
    contextRequests: 0,
    contextAttributes: null,
    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    },
    getContext(type, attributes) {
      this.contextRequests += 1;
      this.contextAttributes = attributes ?? null;
      if (throws) throw new Error("WebGL is blocked");
      return type === "webgl" ? this.gl : null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    fire: events.emit,
    listening: events.count,
  };
}

function fakeWindow({ reduced = false, hidden = false, dpr = 2, observer = true, tokens = {} } = {}) {
  const windowEvents = listenerBag();
  const documentEvents = listenerBag();
  const motionEvents = listenerBag();
  const motion = {
    matches: reduced,
    addEventListener: motionEvents.addEventListener,
    removeEventListener: motionEvents.removeEventListener,
  };
  const values = { ...TOKENS, ...tokens };
  const frames = new Map();
  const observers = [];
  let nextFrame = 1;
  const doc = {
    hidden,
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
  };
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const win = {
    document: doc,
    devicePixelRatio: dpr,
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    getComputedStyle: () => ({ getPropertyValue: (name) => values[name] ?? "" }),
    matchMedia: (query) => (query === "(prefers-reduced-motion: reduce)" ? motion : { matches: false }),
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    IntersectionObserver: observer ? FakeObserver : undefined,
  };
  return {
    win,
    doc,
    frames,
    observers,
    // Runs the frames asked for so far, as the browser does before its next paint.
    runFrames(ms) {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(ms);
    },
    intersect(isIntersecting) {
      for (const o of observers) o.callback([{ isIntersecting, target: o.targets[0] }]);
    },
    setHidden(value) {
      doc.hidden = value;
      documentEvents.emit("visibilitychange");
    },
    resize() {
      windowEvents.emit("resize");
    },
    setReduced(value) {
      motion.matches = value;
      motionEvents.emit("change");
    },
    listening: () => windowEvents.count() + documentEvents.count() + motionEvents.count(),
  };
}

describe("ribbon.js", () => {
  test("tokenColor reads #rrggbb, with spaces around it, and rejects every other shape", () => {
    const { tokenColor } = loadRibbon();
    const asked = [];
    const style = (value) => ({
      getPropertyValue: (name) => {
        asked.push(name);
        return value;
      },
    });
    assert.deepEqual(plain(tokenColor(style(" #0B57e3 "), "--orbit-500")), [11 / 255, 87 / 255, 227 / 255]);
    assert.deepEqual(asked, ["--orbit-500"]);
    for (const value of ["", "#fff", "#0b57e3ff", "0b57e3", "#0b57eg", "rgb(11, 87, 227)", "var(--orbit-500)"]) {
      assert.equal(tokenColor(style(value), "--orbit-500"), null, JSON.stringify(value));
    }
  });

  test("hides the canvas and returns null when a token or WebGL fails", () => {
    const cases = [
      ["a token in another shape", fakeCanvas(), { "--orbit-500": "rgb(11, 87, 227)" }],
      ["a missing token", fakeCanvas(), { "--orbit-50": "" }],
      ["no WebGL context", fakeCanvas({ gl: null }), {}],
      ["getContext throws", fakeCanvas({ throws: true }), {}],
      ["a shader that does not compile", fakeCanvas({ gl: fakeGl({ compiles: false }) }), {}],
      ["a program that does not link", fakeCanvas({ gl: fakeGl({ links: false }) }), {}],
    ];
    for (const [name, canvas, tokens] of cases) {
      const env = fakeWindow({ tokens });
      assert.equal(loadRibbon().start(canvas, env.win), null, name);
      assert.equal(canvas.hidden, true, name);
      assert.equal(env.frames.size, 0, name);
      assert.equal(env.listening(), 0, name);
      assert.equal(canvas.gl?.draws ?? 0, 0, name);
    }
  });

  test("under reduced motion draws one still frame, and again on resize", () => {
    const env = fakeWindow({ reduced: true });
    const canvas = fakeCanvas({ attrs: { "data-ribbon": "", "data-ribbon-offset": "11" } });
    assert.equal(typeof loadRibbon().start(canvas, env.win), "function");
    assert.equal(canvas.gl.draws, 1);
    assert.equal(canvas.gl.uniforms.uTime, 15);
    assert.equal(env.frames.size, 0);
    assert.equal(env.observers.length, 0);
    canvas.rect = { width: 800, height: 600 };
    env.resize();
    assert.equal(canvas.gl.draws, 2);
    assert.deepEqual([canvas.width, canvas.height], [1200, 900]);
    assert.equal(env.frames.size, 0);
  });

  test("turning reduced motion on stops on a still frame, and turning it off resumes", () => {
    const env = fakeWindow();
    const canvas = fakeCanvas({ attrs: { "data-ribbon": "", "data-ribbon-offset": "11" } });
    loadRibbon().start(canvas, env.win);
    env.intersect(true);
    env.runFrames(1000);
    assert.equal(canvas.gl.draws, 1);
    env.setReduced(true);
    assert.equal(env.frames.size, 0, "the loop stops");
    assert.equal(canvas.gl.draws, 2);
    assert.equal(canvas.gl.uniforms.uTime, 15, "the still frame");
    env.resize();
    assert.equal(canvas.gl.draws, 3, "a resize redraws the still frame");
    env.setReduced(false);
    assert.equal(env.frames.size, 1, "the loop resumes");
    env.runFrames(5000);
    assert.equal(canvas.gl.uniforms.uTime, 16);
    env.resize();
    assert.equal(canvas.gl.draws, 4, "a moving ribbon waits for its next frame");
  });

  test("a page loaded under reduced motion starts moving once the setting is turned off", () => {
    const env = fakeWindow({ reduced: true });
    const canvas = fakeCanvas();
    loadRibbon().start(canvas, env.win);
    assert.equal(env.observers.length, 0);
    env.setReduced(false);
    assert.equal(env.observers[0].targets[0], canvas);
    env.intersect(true);
    assert.equal(env.frames.size, 1);
  });

  test("draws at most about 30 frames a second, whatever the display's rate", () => {
    const env = fakeWindow({ observer: false });
    const canvas = fakeCanvas();
    loadRibbon().start(canvas, env.win);
    // A 120 Hz display: a frame every 8.33 ms for half a second.
    for (let i = 0; i <= 60; i++) env.runFrames(1000 + (i * 1000) / 120);
    assert.equal(canvas.gl.draws, 16);
    assert.equal(env.frames.size, 1, "keeps asking for frames");
  });

  test("asks for a low-power context without alpha, antialiasing or depth", () => {
    const canvas = fakeCanvas();
    loadRibbon().start(canvas, fakeWindow().win);
    assert.deepEqual(plain(canvas.contextAttributes), {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
  });

  test("draws at the CSS size times the pixel ratio, at most 1.5 and 2400 px wide", () => {
    for (const [rect, dpr, size] of [
      [{ width: 1440, height: 900 }, 2, [2160, 1350]],
      [{ width: 1440, height: 900 }, 1, [1440, 900]],
      [{ width: 2000, height: 900 }, 2, [2400, 1080]],
      [{ width: 0, height: 0 }, 2, [1, 1]],
    ]) {
      const env = fakeWindow({ dpr, reduced: true });
      const canvas = fakeCanvas({ rect });
      loadRibbon().start(canvas, env.win);
      assert.deepEqual([canvas.width, canvas.height], size, JSON.stringify(rect));
      assert.deepEqual(canvas.gl.uniforms.uRes, size, JSON.stringify(rect));
    }
  });

  test("animates only while the canvas is in view and the page is visible", () => {
    const env = fakeWindow();
    const canvas = fakeCanvas();
    loadRibbon().start(canvas, env.win);
    assert.equal(env.observers[0].targets[0], canvas);
    assert.equal(env.frames.size, 0, "waits for the observer");
    env.intersect(true);
    assert.equal(env.frames.size, 1);
    env.runFrames(1000);
    assert.equal(canvas.gl.draws, 1);
    assert.equal(env.frames.size, 1, "asks for the next frame");
    env.setHidden(true);
    assert.equal(env.frames.size, 0, "a hidden tab stops it");
    env.setHidden(false);
    assert.equal(env.frames.size, 1);
    env.intersect(false);
    assert.equal(env.frames.size, 0, "off screen stops it");
    env.runFrames(2000);
    assert.equal(canvas.gl.draws, 1);
    env.intersect(true);
    env.runFrames(3000);
    assert.equal(canvas.gl.draws, 2);
    assert.equal(canvas.gl.uniforms.uTime, 3);
  });

  test("a tab opened in the background starts the ribbon once it is shown", () => {
    const env = fakeWindow({ hidden: true });
    loadRibbon().start(fakeCanvas(), env.win);
    env.intersect(true);
    assert.equal(env.frames.size, 0);
    env.setHidden(false);
    assert.equal(env.frames.size, 1);
  });

  test("without IntersectionObserver it animates while the page is visible", () => {
    const env = fakeWindow({ observer: false });
    const canvas = fakeCanvas();
    loadRibbon().start(canvas, env.win);
    assert.equal(env.frames.size, 1);
    env.runFrames(16);
    assert.equal(canvas.gl.draws, 1);
    env.setHidden(true);
    assert.equal(env.frames.size, 0);
  });

  test("a lost WebGL context hides the canvas and stops the loop", () => {
    const env = fakeWindow();
    const canvas = fakeCanvas();
    loadRibbon().start(canvas, env.win);
    env.intersect(true);
    env.runFrames(16);
    canvas.fire("webglcontextlost");
    assert.equal(canvas.hidden, true);
    assert.equal(env.frames.size, 0);
    assert.equal(env.observers[0].disconnected, true);
    assert.equal(env.listening(), 0);
    assert.equal(canvas.listening(), 0);
    env.intersect(true);
    assert.equal(env.frames.size, 0);
  });

  test("the stop function cancels the frame and removes every listener", () => {
    const env = fakeWindow();
    const canvas = fakeCanvas();
    const stop = loadRibbon().start(canvas, env.win);
    env.intersect(true);
    stop();
    assert.equal(env.frames.size, 0);
    assert.equal(env.listening(), 0);
    assert.equal(canvas.listening(), 0);
    assert.equal(env.observers[0].disconnected, true);
    assert.equal(canvas.hidden, false);
  });

  test("passes the angle, the offset and the token colors to the shader", () => {
    const env = fakeWindow();
    const canvas = fakeCanvas({
      attrs: { "data-ribbon": "", "data-ribbon-angle": "0.32", "data-ribbon-offset": "11" },
    });
    loadRibbon().start(canvas, env.win);
    env.intersect(true);
    env.runFrames(500);
    const { uniforms } = canvas.gl;
    assert.equal(uniforms.uAng, 0.32);
    assert.equal(uniforms.uTime, 11.5);
    assert.deepEqual(uniforms.uBg, [11 / 255, 14 / 255, 18 / 255]);
    assert.deepEqual(uniforms.uDeep, [5 / 255, 42 / 255, 112 / 255]);
    assert.deepEqual(uniforms.uMid, [11 / 255, 87 / 255, 227 / 255]);
    assert.deepEqual(uniforms.uHi, [138 / 255, 170 / 255, 255 / 255]);
    assert.deepEqual(uniforms.uRim, [237 / 255, 243 / 255, 255 / 255]);
    assert.deepEqual([...canvas.gl.asked].sort(), UNIFORMS);
    for (const name of UNIFORMS) {
      assert.match(CODE, new RegExp(`uniform [a-z0-9]+ [^;]*\\b${name}\\b`), `the shader declares ${name}`);
    }
  });

  test("falls back to angle 0.74 and offset 0 when the attributes are missing or not numbers", () => {
    const env = fakeWindow();
    const canvas = fakeCanvas({ attrs: { "data-ribbon": "", "data-ribbon-angle": "wide" } });
    loadRibbon().start(canvas, env.win);
    env.intersect(true);
    env.runFrames(1000);
    assert.equal(canvas.gl.uniforms.uAng, 0.74);
    assert.equal(canvas.gl.uniforms.uTime, 1);
  });

  test("startAll starts every canvas[data-ribbon] and nothing else", () => {
    const env = fakeWindow();
    const hero = fakeCanvas();
    const cta = fakeCanvas();
    const other = fakeCanvas({ attrs: {} });
    const selectors = [];
    const doc = Object.assign(env.doc, {
      querySelectorAll(selector) {
        selectors.push(selector);
        return [hero, cta, other].filter((c) => Object.hasOwn(c.attrs, "data-ribbon"));
      },
    });
    const stops = loadRibbon().startAll(doc, env.win);
    assert.deepEqual(selectors, ["canvas[data-ribbon]"]);
    assert.equal(stops.length, 2);
    assert.equal(hero.contextRequests, 1);
    assert.equal(cta.contextRequests, 1);
    assert.equal(other.contextRequests, 0);
  });

  test("makes no network request", () => {
    assert.doesNotMatch(CODE, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/);
  });

  test("starts by itself only where there is a document and a window", () => {
    for (const [globals, starts] of [
      [["document", "window"], true],
      [["window"], false],
      [["document"], false],
    ]) {
      const env = fakeWindow();
      const asked = [];
      const doc = Object.assign(env.doc, {
        querySelectorAll(selector) {
          asked.push(selector);
          return [];
        },
      });
      const context = vm.createContext({});
      if (globals.includes("document")) context.document = doc;
      if (globals.includes("window")) context.window = env.win;
      vm.runInContext(CODE, context, { filename: "ribbon.js" });
      assert.deepEqual(asked, starts ? ["canvas[data-ribbon]"] : [], globals.join(" and "));
    }
  });
});
