import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

const BINARY = path.resolve(
  __dirname,
  "..",
  "..",
  "target",
  "debug",
  process.platform === "win32" ? "skopos-fakesshd.exe" : "skopos-fakesshd",
);
const START_TIMEOUT_MS = 15000;

/** The tunnels spec reads the fixture's server from these, which the launcher hands it. */
export const SSHD_PORT_VAR = "SKOPOS_E2E_SSHD_PORT";
export const SSHD_PASSWORD_VAR = "SKOPOS_E2E_SSHD_PASSWORD";

/**
 * Spawns `target/debug/skopos-fakesshd`, a test SSH server (tunnels spec §6.6) that wants
 * `user` and `password` and forwards each `hosts` key (`name:port`) to its address.
 */
export async function startFakeSshd(opts: {
  user: string;
  password: string;
  hosts: Record<string, string>;
}): Promise<{ port: number; stop(): Promise<void> }> {
  const args = ["--user", opts.user, "--password", opts.password];
  for (const [name, address] of Object.entries(opts.hosts)) {
    args.push("--host", `${name}=${address}`);
  }
  const child: ChildProcess = spawn(BINARY, args, {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error("skopos-fakesshd did not report its address")),
      START_TIMEOUT_MS,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`skopos-fakesshd exited with ${code} before it was ready`));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(Number(found[1]));
      }
    });
  });

  return {
    port,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGINT");
      await exited;
    },
  };
}
