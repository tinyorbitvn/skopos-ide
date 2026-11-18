import { useWindowLayout } from "../../stores/windowLayout";
import { IS_MAC, matchesShortcut } from "../shortcuts";
import { focusedPane, focusedTab, type LayoutAction } from "./layout";

/** The DOM id of a tab's button in its strip. */
export function tabElementId(tabId: string): string {
  return `pane-tab-${tabId}`;
}

/** Puts the keyboard focus on a tab's button, when it is in the page. */
export function focusTabElement(tabId: string | undefined): void {
  if (tabId) document.getElementById(tabElementId(tabId))?.focus();
}

function dispatch(action: LayoutAction): void {
  useWindowLayout.getState().dispatch(action);
}

function layout() {
  return useWindowLayout.getState().layout;
}

/** The focused pane's selected tab gets the keyboard focus, so the strip keys go on from there. */
function focusSelected(): void {
  const pane = focusedPane(layout());
  focusTabElement(pane?.selected);
}

/** Copies the focused tab into a new pane on the right (P16, P20); at 3 panes nothing. */
export function splitFocusedTab(): void {
  const pane = focusedPane(layout());
  if (pane === null) return;
  dispatch({
    type: "split",
    paneId: pane.id,
    newTabId: crypto.randomUUID(),
    newPaneId: crypto.randomUUID(),
  });
}

/** Closes the focused tab unless it is pinned (P14); true when it closed. */
export function closeFocusedTab(): boolean {
  const tab = focusedTab(layout());
  if (tab === null) return false;
  const before = layout();
  dispatch({ type: "close", tabId: tab.id });
  return layout() !== before;
}

/** A modal dialog, the palette or a popover: the keys then belong to it. */
function dialogOpen(): boolean {
  return (
    document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
  );
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".xterm") !== null;
}

/**
 * The "Tabs and windows" keys (spec P16): Mod+\ copies the focused tab into a new pane
 * on the right, Mod+W closes it, Ctrl+Tab and Ctrl+Shift+Tab move along the focused
 * pane's tabs, wrapping, and Mod+1 to Mod+3 focus a pane. The listener sits on
 * `window` in the capture phase, so screens and editors do not see these keys, except
 * a terminal off macOS, where Ctrl+W and Ctrl+\ belong to the shell. Returns a
 * function that removes it.
 */
export function installTabKeys(mac = IS_MAC): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || dialogOpen()) return;
    const shellKeys = !mac && inTerminal(event.target);
    let run: (() => void) | null = null;
    if (matchesShortcut("cycleTabs", event, mac)) {
      // Held down, it keeps moving.
      const delta = event.shiftKey ? -1 : 1;
      run = () => {
        dispatch({ type: "cycle", delta });
        focusSelected();
      };
    } else if (event.repeat) {
      return;
    } else if (matchesShortcut("closeTab", event, mac) && !shellKeys) {
      run = () => {
        // The closed tab's screen had the focus: it goes to the tab shown now.
        if (closeFocusedTab()) focusSelected();
      };
    } else if (matchesShortcut("splitRight", event, mac) && !shellKeys) {
      run = splitFocusedTab;
    } else if (matchesShortcut("focusPane", event, mac)) {
      const digit = /^Digit\d$/.test(event.code)
        ? event.code.slice(5)
        : event.key;
      const index = Number(digit) - 1;
      run = () => {
        const pane = layout().panes[index];
        if (pane === undefined) return;
        dispatch({ type: "focusPane", paneId: pane.id });
        focusSelected();
      };
    }
    if (run === null) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  }
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
