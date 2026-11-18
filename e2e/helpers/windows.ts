/**
 * Backend calls and window switching for specs that open more than one window. The e2e
 * build sets `withGlobalTauri`, so a page can call any command as the window it is in.
 */

interface TauriGlobal {
  __TAURI__: {
    core: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
  };
  __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } };
}

export interface TabSummary {
  id: string;
  history: string[];
}

export interface LayoutSummary {
  label: string;
  panes: { tabs: TabSummary[] }[];
}

/** How long `invokeAndForget` waits before it starts the command. */
const FORGET_DELAY_MS = 200;

/** Calls a backend command from the window the driver is on and gives its result. */
export async function invoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await browser.execute(
    (c: string, a: Record<string, unknown>) =>
      (window as unknown as TauriGlobal).__TAURI__.core.invoke(c, a),
    cmd,
    args,
  )) as T;
}

/**
 * Starts a backend command from the window the driver is on without waiting for it, for
 * a command that closes that window before it can answer. The command starts a moment
 * after the script returns: a window that closed while the driver waited for the script's
 * answer failed the call ("no such window").
 */
export async function invokeAndForget(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await browser.execute(
    (c: string, a: Record<string, unknown>, delay: number) => {
      setTimeout(() => {
        void (window as unknown as TauriGlobal).__TAURI__.core
          .invoke(c, a)
          .catch(() => {});
      }, delay);
    },
    cmd,
    args,
    FORGET_DELAY_MS,
  );
}

/** The labels of the open windows as the core lists them, `main` first. */
export async function windowLabels(): Promise<string[]> {
  const layouts = await invoke<LayoutSummary[]>("windows_list");
  return layouts.map((layout) => layout.label);
}

export function tabIds(layout: LayoutSummary): string[] {
  return layout.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id));
}

/** The label of the window the driver is on, or null while its page is not ready. */
async function currentLabel(): Promise<string | null> {
  try {
    return await browser.execute(
      () =>
        (window as unknown as TauriGlobal).__TAURI_INTERNALS__?.metadata
          ?.currentWebview?.label ?? null,
    );
  } catch {
    return null;
  }
}

/** The driver's script timeout outside `switchToLabel`: the W3C default. */
const SCRIPT_TIMEOUT = 30000;

/**
 * The script timeout while `switchToLabel` asks each window for its label. The embedded
 * driver runs a script without waiting for the page, then polls the page for its result.
 * A script sent to a new window before its page has loaded goes with the first document,
 * so its result never comes and the call ends only at the script timeout. A short one
 * lets the next try reach the loaded page.
 */
const SWITCH_SCRIPT_TIMEOUT = 3000;

/** Switches the driver to the window `label`, waiting until it is open. */
export async function switchToLabel(
  label: string,
  timeout = 30000,
): Promise<void> {
  await browser.setTimeout({ script: SWITCH_SCRIPT_TIMEOUT });
  try {
    await browser.waitUntil(
      async () => {
        for (const handle of await browser.getWindowHandles()) {
          try {
            await browser.switchToWindow(handle);
          } catch {
            continue;
          }
          if ((await currentLabel()) === label) return true;
        }
        return false;
      },
      { timeout, timeoutMsg: `window ${label} did not open` },
    );
  } finally {
    await browser.setTimeout({ script: SCRIPT_TIMEOUT });
  }
}

/** Waits until the driver sees `count` windows. */
export async function expectWindowCount(
  count: number,
  timeout = 30000,
): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.getWindowHandles()).length === count,
    { timeout, timeoutMsg: `expected ${count} windows` },
  );
}
