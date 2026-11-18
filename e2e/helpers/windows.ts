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
 * a command that closes that window before it can answer.
 */
export async function invokeAndForget(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await browser.execute(
    (c: string, a: Record<string, unknown>) => {
      void (window as unknown as TauriGlobal).__TAURI__.core
        .invoke(c, a)
        .catch(() => {});
    },
    cmd,
    args,
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

/** Switches the driver to the window `label`, waiting until it is open. */
export async function switchToLabel(
  label: string,
  timeout = 30000,
): Promise<void> {
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
