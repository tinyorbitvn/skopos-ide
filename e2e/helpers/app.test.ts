import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { keepAppLogs, stopApp } from "./app.ts";

// A stand-in for the app's embedded WebDriver server. When its window is closed it
// either quits at once, cutting the request off, or keeps running with no window.
const FAKE_APP = `
const http = require("node:http");
const mode = process.argv[1];
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/session") {
    res.end(JSON.stringify({ value: { sessionId: "s1", capabilities: {} } }));
  } else if (req.method === "DELETE" && req.url === "/session/s1/window") {
    if (mode === "quits") process.exit(0);
    res.end(JSON.stringify({ value: [] }));
  } else {
    res.end(JSON.stringify({ value: { ready: true } }));
  }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

type FakeApp = { child: ChildProcess; port: number; exited: Promise<unknown> };

async function startFakeApp(mode: "quits" | "stays"): Promise<FakeApp> {
  const child = spawn(process.execPath, ["-e", FAKE_APP, mode], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  const [line] = await once(child.stdout, "data");
  return { child, port: Number(String(line).trim()), exited };
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-app-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("an app that quits while its window closes is not an error", { timeout: 10000 }, async (t) => {
  const app = await startFakeApp("quits");
  t.after(() => app.child.kill());
  assert.equal(await stopApp(tempDir(t), app.port), "exited");
  await app.exited;
});

// On macOS the stalled app's stacks are sampled first, which takes a few seconds.
test("an app still running after its window closed is killed", { timeout: 20000 }, async (t) => {
  const app = await startFakeApp("stays");
  t.after(() => app.child.kill());
  assert.equal(await stopApp(tempDir(t), app.port, 300), "killed");
  await app.exited;
});

test("the logs of each app config dir are kept apart", (t) => {
  const kept = tempDir(t);
  const first = tempDir(t);
  const second = tempDir(t);
  fs.mkdirSync(path.join(first, "logs"));
  fs.writeFileSync(path.join(first, "logs", "skopos.log"), "first\n");

  keepAppLogs([first, second], kept);

  assert.deepEqual(fs.readdirSync(kept), [path.basename(first)]);
  assert.equal(fs.readFileSync(path.join(kept, path.basename(first), "skopos.log"), "utf8"), "first\n");
});
