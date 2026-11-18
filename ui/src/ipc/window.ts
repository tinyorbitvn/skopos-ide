import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** The first window; closing it quits the app (spec P32, P34). */
export const MAIN_WINDOW = "main";

/**
 * This window's label: `main` or `window-<n>` (P32). Outside Tauri, as in tests that
 * mock no window, it is `main`.
 */
export function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return MAIN_WINDOW;
  }
}
