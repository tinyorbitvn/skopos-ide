import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");
const DIR = path.join(REPO, "e2e", ".tmp", "fakeagent");
const BINARY = path.join(
  REPO,
  "target",
  "debug",
  process.platform === "win32" ? "skopos-fakeagent.exe" : "skopos-fakeagent",
);

/** A custom agent's id: `custom-` and eight hex digits, as the core makes them. */
export const FAKE_AGENT_ID = "custom-0000e2e0";
export const FAKE_AGENT_NAME = "Fake agent";
export const SCRIPT = path.join(DIR, "script.json");
export const LOG = path.join(DIR, "agent.log");

/** One step of the fake agent's script. */
export type Step =
  | { say: string }
  | { tool: { name: string; args: Record<string, unknown> } }
  | { sleep: number }
  | { permission: { title: string; kind?: string; command?: string } };

export const say = (text: string): Step => ({ say: text });
export const tool = (name: string, args: Record<string, unknown>): Step => ({
  tool: { name, args },
});

/** The agent asks to run `command`, waits for the answer, then plays the next step. */
export const permission = (title: string, command: string): Step => ({
  permission: { title, kind: "execute", command },
});

/**
 * Writes the script the next agent process plays, one turn per prompt. The agent reads it
 * when it starts, so write it before the chat starts (opening the panel, New chat).
 */
export function writeFakeAgentScript(
  turns: Step[][],
  options: { configOptions?: unknown[] } = {},
): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    SCRIPT,
    JSON.stringify({ ...options, turns: turns.map((steps) => ({ steps })) }),
  );
}

/** The preferences that add the fake agent and make it the default. */
export function fakeAgentPrefs(): Record<string, unknown> {
  if (!fs.existsSync(BINARY)) {
    throw new Error(
      `${BINARY} is missing; run cargo build -p skopos-core --bin skopos-fakeagent`,
    );
  }
  writeFakeAgentScript([]);
  return {
    agents: {
      defaultAgent: FAKE_AGENT_ID,
      custom: [
        {
          id: FAKE_AGENT_ID,
          name: FAKE_AGENT_NAME,
          command: `"${BINARY}" --script "${SCRIPT}" --log "${LOG}"`,
        },
      ],
    },
  };
}
