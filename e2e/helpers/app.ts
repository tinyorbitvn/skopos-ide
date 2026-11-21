import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EMBEDDED_PORT = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4445);
// Shorter than the app's own quit limit (`QUIT_LIMIT`), so a stalled quit is seen here.
const EXIT_TIMEOUT_MS = 15000;

async function serverIsUp(base: string): Promise<boolean> {
  try {
    await fetch(`${base}/status`);
    return true;
  } catch {
    return false;
  }
}

/** Whether the server at `base` goes down within `timeoutMs`. */
async function serverGoesDown(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await serverIsUp(base)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** The process listening on `port`, from the system's socket table. */
function listenerPid(port: number): number | undefined {
  try {
    if (process.platform === "win32") {
      const rows = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" })
        .split(/\r?\n/)
        .map((row) => row.trim().split(/\s+/));
      const row = rows.find((cols) => cols[1]?.endsWith(`:${port}`) && cols[3] === "LISTENING");
      return row ? Number(row[4]) : undefined;
    }
    if (process.platform === "linux") {
      const out = execFileSync("ss", ["-Hltnp", `sport = :${port}`], { encoding: "utf8" });
      const pid = /pid=(\d+)/.exec(out)?.[1];
      return pid ? Number(pid) : undefined;
    }
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    });
    return Number(out.split("\n")[0]) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves the stacks of every thread of the stalled process `pid` under `dir`, where the
 * system has a tool for it (macOS `sample`), so the run shows where the quit is stuck.
 */
function saveStacks(pid: number, dir: string): void {
  if (process.platform !== "darwin") return;
  const file = path.join(dir, `stalled-${pid}.sample.txt`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("sample", [String(pid), "3", "-file", file], { stdio: "ignore", timeout: 30000 });
    console.warn(`the stacks of process ${pid} are in ${file}`);
  } catch (err) {
    console.warn(`cannot save the stacks of process ${pid}: ${err}`);
  }
}

/**
 * Ends the running app by closing its only window, and says whether it exited or had to
 * be killed. A killed app's stacks are saved in `diagnosticsDir` first. The tauri service keeps one
 * app across spec files and starts a new one only when it finds the old one
 * gone, using the environment of that moment.
 *
 * The app can quit before it answers the close, and on macOS an app closed right
 * after it started has stayed up with no window. Both must still end with the app
 * gone, or the next spec file gets an app without its environment.
 */
export async function stopApp(
  diagnosticsDir: string,
  port = EMBEDDED_PORT,
  exitTimeoutMs = EXIT_TIMEOUT_MS,
): Promise<"exited" | "killed"> {
  const base = `http://127.0.0.1:${port}`;
  if (!(await serverIsUp(base))) return "exited";
  try {
    const created = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
    });
    const { value } = (await created.json()) as { value: { sessionId: string } };
    await fetch(`${base}/session/${value.sessionId}/window`, { method: "DELETE" });
  } catch {
    // The app quit while answering, or cannot close its window: the wait below decides.
  }
  if (await serverGoesDown(base, exitTimeoutMs)) return "exited";

  const pid = listenerPid(port);
  if (pid === undefined) {
    throw new Error(`the app did not exit within ${exitTimeoutMs} ms`);
  }
  console.warn(`the app did not exit within ${exitTimeoutMs} ms; killing process ${pid}`);
  saveStacks(pid, diagnosticsDir);
  process.kill(pid, "SIGKILL");
  if (!(await serverGoesDown(base, exitTimeoutMs))) {
    throw new Error(`the app was still up ${exitTimeoutMs} ms after process ${pid} was killed`);
  }
  return "killed";
}

/**
 * Copies the log folder of each app config dir into `dir`, one folder per config dir,
 * before the run removes them.
 */
export function keepAppLogs(configDirs: string[], dir: string): void {
  for (const configDir of configDirs) {
    const logs = path.join(configDir, "logs");
    if (!fs.existsSync(logs)) continue;
    try {
      fs.cpSync(logs, path.join(dir, path.basename(configDir)), { recursive: true });
    } catch (err) {
      console.warn(`cannot keep the app logs in ${logs}: ${err}`);
    }
  }
}
