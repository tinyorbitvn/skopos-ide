import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { expect, test } from "vitest";
import { emitEvent, mockBackend } from "../test/ipc";
import { events } from "./events";
import type { ToolProgress } from "./generated/ToolProgress";
import type { WindowLayout } from "./generated/WindowLayout";

const PROGRESS: ToolProgress = {
  tool: "helm",
  phase: "downloading",
  receivedBytes: 1024,
  totalBytes: 4096,
  error: null,
};

test("onToolsProgress hands each tools://progress payload over until it is unlistened", async () => {
  mockBackend({});
  const seen: ToolProgress[] = [];
  const unlisten = await events.onToolsProgress((p) => seen.push(p));

  await emitEvent("tools://progress", PROGRESS);
  unlisten();
  await emitEvent("tools://progress", { ...PROGRESS, phase: "done" });

  expect(seen).toEqual([PROGRESS]);
});

function layout(label: string): WindowLayout {
  return {
    label,
    bounds: null,
    panes: [{ id: "pane-1", width: 1, selected: "", tabs: [] }],
    focusedPane: 0,
  };
}

test("onWindowLayout hands over this window's layout and no other window's", async () => {
  mockBackend({});
  mockWindows("window-2");
  const seen: string[] = [];
  const unlisten = await events.onWindowLayout((l) => seen.push(l.label));

  await emitEvent("window://layout", layout("main"));
  await emitEvent("window://layout", layout("window-2"));
  unlisten();
  await emitEvent("window://layout", layout("window-2"));

  expect(seen).toEqual(["window-2"]);
});

// Tauri hands an event sent to one window to every listener without a target, in every
// window, so these listeners name their own window.
test.each<[string, () => Promise<unknown>]>([
  ["window://layout", () => events.onWindowLayout(() => {})],
  ["menu://command", () => events.onMenuCommand(() => {})],
])("%s is listened to on this window only", async (name, subscribe) => {
  const listens: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:event|listen") listens.push(args);
    return 1;
  });
  mockWindows("window-3");

  await subscribe();

  expect(listens).toEqual([
    expect.objectContaining({
      event: name,
      target: { kind: "WebviewWindow", label: "window-3" },
    }),
  ]);
});

test("onMenuCommand hands each menu://command over", async () => {
  mockBackend({});
  const seen: string[] = [];
  await events.onMenuCommand(({ id }) => seen.push(id));

  await emitEvent("menu://command", { id: "palette" });

  expect(seen).toEqual(["palette"]);
});

test("onCatalogFoldersChanged fires on every catalog://folders-changed", async () => {
  mockBackend({});
  let count = 0;
  await events.onCatalogFoldersChanged(() => {
    count += 1;
  });

  await emitEvent("catalog://folders-changed");
  await emitEvent("catalog://folders-changed");

  expect(count).toBe(2);
});
