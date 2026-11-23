import { PLATFORM } from "../../app/shortcuts";

let supported = PLATFORM !== "windows";

/**
 * Agents run only inside the sandbox, which exists on Linux and macOS. On Windows the app
 * shows no agent UI at all (agents spec §2, §11).
 */
export function agentsSupported(): boolean {
  return supported;
}

/** Tests only: `false` shows the app as Windows shows it. */
export function setAgentsSupportedForTest(value: boolean): void {
  supported = value;
}
