/*
 * Draws the orbit ribbon behind the hero and the call to action: a WebGL 1 fragment shader
 * on every canvas[data-ribbon], in the page's own tokens. The page works without this
 * script: the canvas stays transparent and the CSS glow behind it shows. When the tokens or
 * WebGL fail, the canvas hides, with the same result. Under reduced motion it draws one
 * still frame, and it follows that setting when it changes. It animates, at about 30 frames
 * a second, only while its canvas is on screen and the tab is visible. Nothing is fetched.
 */
(function (global) {
  "use strict";

  const VERTEX = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

  // A twisted band along a wavy centerline. q is the plane turned by uAng; s runs along the
  // band, d across it, th is the twist. The band is lit by its twist, grained like fiber,
  // and fades at its tail.
  const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime, uAng;
uniform vec3 uBg, uDeep, uMid, uHi, uRim;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime;
  vec2 q = vec2(p.x * cos(uAng) + p.y * sin(uAng), -p.x * sin(uAng) + p.y * cos(uAng));
  float s = q.x;
  float c = 0.05 + 0.17 * sin(1.9 * s + 0.30 * t) + 0.07 * sin(4.1 * s - 0.22 * t + 1.3);
  float w = 0.21 + 0.06 * sin(1.1 * s - 0.17 * t + 0.8);
  float th = 0.9 + 1.4 * sin(1.25 * s - 0.29 * t) + 0.5 * sin(2.6 * s + 0.19 * t + 2.0);
  float ct = cos(th);
  float pw = w * abs(ct) + 0.004;
  float d = q.y - c;
  float u = d / pw;
  float aa = 1.5 / (pw * uRes.y);
  float body = 1.0 - smoothstep(1.0 - aa, 1.0, abs(u));
  float face = sign(ct);
  float phi = th + 0.7 * u * face;
  float diff = pow(0.5 + 0.5 * cos(phi - 0.5), 2.0);
  float spec = pow(max(cos(phi - 0.25), 0.0), 28.0);
  float edgeOn = pow(1.0 - abs(ct), 5.0);
  float rim = smoothstep(0.78, 1.0, u * face) * 0.45;
  float tail = smoothstep(-1.25, -0.45, s);
  float I = (0.06 + 0.62 * diff + 0.55 * spec + 1.0 * edgeOn + rim) * mix(0.3, 1.0, tail);
  if (face < 0.0) I *= 0.55;
  vec3 rib = mix(uDeep, uMid, smoothstep(0.08, 0.5, I));
  rib = mix(rib, uHi, smoothstep(0.5, 0.92, I));
  rib = mix(rib, uRim, smoothstep(1.0, 1.5, I));
  float fiber = hash(floor(vec2(s * 650.0, u * 70.0)));
  rib *= 0.9 + 0.2 * fiber * (1.0 - 0.6 * smoothstep(0.9, 1.4, I));
  float dist = max(abs(d) - pw, 0.0);
  vec3 col = uBg + uDeep * exp(-dist * 9.0) * 0.55 * tail;
  col = mix(col, rib, body);
  col += (hash(gl_FragCoord.xy + floor(t * 24.0)) - 0.5) * 0.035;
  gl_FragColor = vec4(col, 1.0);
}`;

  // Uniform → token. Each must be a #rrggbb color.
  const COLORS = {
    uBg: "--gray-950",
    uDeep: "--orbit-800",
    uMid: "--orbit-500",
    uHi: "--orbit-300",
    uRim: "--orbit-50",
  };
  const MAX_SCALE = 1.5;
  const MAX_WIDTH = 2400;
  const DEFAULT_ANGLE = 0.74;
  // The still frame shows the clock this many seconds after the canvas's offset.
  const STILL_AT = 4;
  // The ribbon moves slowly, so about 30 frames a second look like 60 or 120 and cost the
  // GPU half or a quarter as much. The margin under 33.3 ms absorbs the display's jitter.
  const MIN_FRAME_MS = 28;

  // [r, g, b] in 0..1 for a "#rrggbb" token, spaces around it allowed; null for any other shape.
  function tokenColor(style, name) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(style.getPropertyValue(name)).trim());
    if (!match) return null;
    const n = Number.parseInt(match[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function numberAttribute(canvas, name, fallback) {
    const value = Number.parseFloat(canvas.getAttribute(name) ?? "");
    return Number.isFinite(value) ? value : fallback;
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  }

  function link(gl) {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
  }

  // Draws the ribbon on canvas until the returned function stops it. Returns null, with the
  // canvas hidden, when a token or WebGL fails.
  function start(canvas, win) {
    const doc = win.document;
    const fail = () => {
      canvas.hidden = true;
      return null;
    };

    const style = win.getComputedStyle(canvas);
    const colors = {};
    for (const [uniform, token] of Object.entries(COLORS)) {
      colors[uniform] = tokenColor(style, token);
      if (!colors[uniform]) return fail();
    }

    let gl = null;
    try {
      gl = canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        powerPreference: "low-power",
      });
    } catch {
      gl = null;
    }
    if (!gl) return fail();
    const program = link(gl);
    if (!program) return fail();

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    // One triangle that covers the whole viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const at = (name) => gl.getUniformLocation(program, name);
    for (const [uniform, rgb] of Object.entries(colors)) gl.uniform3fv(at(uniform), rgb);
    gl.uniform1f(at("uAng"), numberAttribute(canvas, "data-ribbon-angle", DEFAULT_ANGLE));
    const offset = numberAttribute(canvas, "data-ribbon-offset", 0);
    const resolution = at("uRes");
    const time = at("uTime");

    function draw(seconds) {
      const rect = canvas.getBoundingClientRect();
      const widest = rect.width > 0 ? MAX_WIDTH / rect.width : MAX_SCALE;
      const scale = Math.min(win.devicePixelRatio || 1, MAX_SCALE, widest);
      const width = Math.max(1, Math.round(rect.width * scale));
      const height = Math.max(1, Math.round(rect.height * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(time, seconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const removers = [];
    const listen = (target, type, fn) => {
      target.addEventListener(type, fn);
      removers.push(() => target.removeEventListener(type, fn));
    };
    let frame = 0;
    let observer = null;
    let stopped = false;
    function stop() {
      stopped = true;
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      if (observer) observer.disconnect();
      for (const remove of removers.splice(0)) remove();
    }
    listen(canvas, "webglcontextlost", () => {
      stop();
      canvas.hidden = true;
    });

    // The browser keeps this list's matches current, and says so with a change event.
    const motion =
      typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const still = () => Boolean(motion?.matches);
    const drawStill = () => draw(offset + STILL_AT);

    // Without IntersectionObserver the canvas counts as always in view.
    let inView = typeof win.IntersectionObserver !== "function";
    let watching = false;
    let last = -Infinity;
    const running = () => !stopped && !still() && inView && !doc.hidden;
    function tick(ms) {
      frame = 0;
      if (!running()) return;
      if (ms - last >= MIN_FRAME_MS) {
        last = ms;
        draw(offset + ms / 1000);
      }
      frame = win.requestAnimationFrame(tick);
    }
    function update() {
      if (running() && !frame) frame = win.requestAnimationFrame(tick);
      if (!running() && frame) {
        win.cancelAnimationFrame(frame);
        frame = 0;
      }
    }
    // Watches the view and the tab from the first moving frame on, so a page that stays
    // under reduced motion never needs the observer.
    function watch() {
      if (watching) return;
      watching = true;
      if (!inView) {
        observer = new win.IntersectionObserver((entries) => {
          for (const entry of entries) inView = entry.isIntersecting;
          update();
        });
        observer.observe(canvas);
      }
      listen(doc, "visibilitychange", update);
    }
    function follow() {
      if (still()) drawStill();
      else watch();
      update();
    }
    // A moving ribbon redraws at its size on its next frame; a still one needs this.
    listen(win, "resize", () => {
      if (still()) drawStill();
    });
    if (motion && typeof motion.addEventListener === "function") listen(motion, "change", follow);
    follow();
    return stop;
  }

  function startAll(doc, win) {
    const stops = [];
    for (const canvas of doc.querySelectorAll("canvas[data-ribbon]")) {
      const stop = start(canvas, win);
      if (stop) stops.push(stop);
    }
    return stops;
  }

  global.SkoposRibbon = { tokenColor, start, startAll };
  if (typeof document !== "undefined" && typeof window !== "undefined") {
    startAll(document, window);
  }
})(globalThis);
