import { afterEach, beforeEach, expect, test } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { tabPath } from "./layout";
import { installTabKeys, tabElementId } from "./tabKeys";

function tab(id: string, path: string, pinned = false): TabState {
  return { id, pinned, history: [path], index: 0 };
}

function twoPanes(): WindowLayout {
  return {
    label: "main",
    bounds: null,
    panes: [
      {
        id: "p1",
        width: 0.5,
        selected: "t1",
        tabs: [
          tab("t1", "/catalog", true),
          tab("t2", "/preferences"),
          tab("t3", "/cluster/c1"),
        ],
      },
      {
        id: "p2",
        width: 0.5,
        selected: "t4",
        tabs: [tab("t4", "/cluster/c1/map")],
      },
    ],
    focusedPane: 0,
  };
}

// Per pane: `p1:*/catalog^,/x`, each tab's shown path, `*` selected, `^` pinned.
function shape(): string {
  const { layout } = useWindowLayout.getState();
  return layout.panes
    .map(
      (p) =>
        `${p.id}:${p.tabs
          .map(
            (t) =>
              `${p.selected === t.id ? "*" : ""}${tabPath(t)}${t.pinned ? "^" : ""}`,
          )
          .join(",")}`,
    )
    .join(" | ");
}

/** Presses a key on `target` (the body by default); true when the app took it. */
function press(init: KeyboardEventInit, target: Element = document.body) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const CTRL_TAB = { key: "Tab", code: "Tab", ctrlKey: true };
const CTRL_W = { key: "w", code: "KeyW", ctrlKey: true };
const CTRL_SPLIT = { key: "\\", code: "Backslash", ctrlKey: true };

let stop = () => {};

beforeEach(() => {
  resetWindowLayoutForTest(twoPanes());
  stop = installTabKeys(false);
});

afterEach(() => {
  stop();
  document.body.innerHTML = "";
});

test("Ctrl+\\ copies the focused tab into a new pane on the right, up to 3 panes (P16, P20)", () => {
  expect(press(CTRL_SPLIT)).toBe(true);
  expect(shape()).toBe(
    "p1:*/catalog^,/preferences,/cluster/c1 | " +
      `${useWindowLayout.getState().layout.panes[1].id}:*/catalog | ` +
      "p2:*/cluster/c1/map",
  );
  expect(useWindowLayout.getState().layout.focusedPane).toBe(1);
  press(CTRL_SPLIT);
  expect(useWindowLayout.getState().layout.panes).toHaveLength(3);
});

test("Ctrl+W closes the focused tab; a pinned tab stays (P14, P16)", () => {
  useWindowLayout.getState().dispatch({ type: "select", tabId: "t2" });
  expect(press(CTRL_W)).toBe(true);
  expect(shape()).toBe("p1:/catalog^,*/cluster/c1 | p2:*/cluster/c1/map");
  useWindowLayout.getState().dispatch({ type: "select", tabId: "t1" });
  press(CTRL_W);
  expect(shape()).toBe("p1:*/catalog^,/cluster/c1 | p2:*/cluster/c1/map");
});

test("Ctrl+Tab and Ctrl+Shift+Tab select the next and previous tab of the focused pane, wrapping", () => {
  press(CTRL_TAB);
  expect(shape()).toBe(
    "p1:/catalog^,*/preferences,/cluster/c1 | p2:*/cluster/c1/map",
  );
  press(CTRL_TAB);
  press(CTRL_TAB);
  expect(shape()).toBe(
    "p1:*/catalog^,/preferences,/cluster/c1 | p2:*/cluster/c1/map",
  );
  press({ ...CTRL_TAB, shiftKey: true });
  expect(shape()).toBe(
    "p1:/catalog^,/preferences,*/cluster/c1 | p2:*/cluster/c1/map",
  );
});

test("Ctrl+1 to Ctrl+3 focus a pane; a pane that is not there changes nothing", () => {
  expect(press({ key: "2", code: "Digit2", ctrlKey: true })).toBe(true);
  expect(useWindowLayout.getState().layout.focusedPane).toBe(1);
  press({ key: "1", code: "Digit1", ctrlKey: true });
  expect(useWindowLayout.getState().layout.focusedPane).toBe(0);
  const before = useWindowLayout.getState().layout;
  press({ key: "3", code: "Digit3", ctrlKey: true });
  expect(useWindowLayout.getState().layout).toBe(before);
});

test("the selected tab of the pane gets the keyboard focus after Ctrl+Tab and Ctrl+2", () => {
  for (const id of ["t1", "t2", "t3", "t4"]) {
    const button = document.createElement("button");
    button.id = tabElementId(id);
    document.body.append(button);
  }
  press(CTRL_TAB);
  expect(document.activeElement?.id).toBe(tabElementId("t2"));
  press({ key: "2", code: "Digit2", ctrlKey: true });
  expect(document.activeElement?.id).toBe(tabElementId("t4"));
});

test("on macOS Cmd+W closes the tab and Ctrl+W does not", () => {
  stop();
  stop = installTabKeys(true);
  useWindowLayout.getState().dispatch({ type: "select", tabId: "t2" });
  expect(press(CTRL_W)).toBe(false);
  expect(press({ key: "w", code: "KeyW", metaKey: true })).toBe(true);
  expect(shape()).toBe("p1:/catalog^,*/cluster/c1 | p2:*/cluster/c1/map");
});

test("a held Ctrl+W closes one tab, while a held Ctrl+Tab keeps moving", () => {
  useWindowLayout.getState().dispatch({ type: "select", tabId: "t2" });
  press(CTRL_W);
  press({ ...CTRL_W, repeat: true });
  expect(shape()).toBe("p1:/catalog^,*/cluster/c1 | p2:*/cluster/c1/map");
  press({ ...CTRL_TAB, repeat: true });
  expect(shape()).toBe("p1:*/catalog^,/cluster/c1 | p2:*/cluster/c1/map");
});

test("the keys do nothing while a dialog is open", () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  const before = useWindowLayout.getState().layout;
  expect(press(CTRL_TAB)).toBe(false);
  expect(press(CTRL_W)).toBe(false);
  expect(useWindowLayout.getState().layout).toBe(before);
});

test("in a terminal off macOS, Ctrl+W and Ctrl+\\ stay with the shell; Ctrl+Tab still moves", () => {
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const input = document.createElement("textarea");
  terminal.append(input);
  document.body.append(terminal);
  useWindowLayout.getState().dispatch({ type: "select", tabId: "t2" });
  const before = useWindowLayout.getState().layout;
  expect(press(CTRL_W, input)).toBe(false);
  expect(press(CTRL_SPLIT, input)).toBe(false);
  expect(useWindowLayout.getState().layout).toBe(before);
  expect(press(CTRL_TAB, input)).toBe(true);
  expect(shape()).toBe(
    "p1:/catalog^,/preferences,*/cluster/c1 | p2:*/cluster/c1/map",
  );
});
