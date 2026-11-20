import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { Toaster } from "../../design";
import { resetShellForTest, useShell } from "../../stores/shell";
import { useUiState } from "../../stores/uiState";
import { emitEvent, flush, mockBackend } from "../../test/ipc";
import { RELEASE, updateState } from "../../test/updates";
import {
  checkForUpdates,
  initUpdates,
  installUpdate,
  resetUpdatesForTest,
  skipUpdate,
  useUpdates,
} from "./updateStore";

beforeEach(() => {
  resetUpdatesForTest();
  resetShellForTest();
});

const available = updateState({
  phase: { type: "available", release: RELEASE },
});

test("init reads the state, then follows update://state", async () => {
  mockBackend({ update_state_get: () => updateState() });
  await act(initUpdates);
  expect(useUpdates.getState().state?.phase).toEqual({ type: "idle" });

  await emitEvent("update://state", available);
  expect(useUpdates.getState().state?.phase.type).toBe("available");
});

test("a failed read leaves no state, and the app shows its version", async () => {
  mockBackend({});
  await act(initUpdates);
  expect(useUpdates.getState().state).toBeNull();
});

test("the announcing change shows one toast, with View, in the window it names", async () => {
  mockBackend({ update_state_get: () => updateState() });
  render(<Toaster />);
  await act(initUpdates);

  await emitEvent("update://state", { ...available, toastWindow: "window-2" });
  expect(screen.queryByText("SkoposIDE 0.10.0 is available")).toBeNull();

  await emitEvent("update://state", { ...available, toastWindow: "main" });
  expect(screen.getByText("SkoposIDE 0.10.0 is available")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  expect(useShell.getState().dialog).toBe("updates");
  expect(screen.queryByText("SkoposIDE 0.10.0 is available")).toBeNull();

  // Later changes carry no toast window.
  await emitEvent("update://state", available);
  expect(screen.queryByText("SkoposIDE 0.10.0 is available")).toBeNull();
});

test("Check for Updates opens the dialog and keeps the state the check ended in", async () => {
  const backend = mockBackend({
    update_check: () => updateState({ phase: { type: "upToDate" } }),
  });
  await act(checkForUpdates);
  expect(useShell.getState().dialog).toBe("updates");
  expect(backend.callsTo("update_check")).toHaveLength(1);
  expect(useUpdates.getState().state?.phase).toEqual({ type: "upToDate" });
});

test("Install and Restart saves pending UI state before it installs", async () => {
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    update_install: () => null,
  });
  const { result } = renderHook(() => useUiState("k", "a"));
  await act(flush);
  act(() => result.current[1]("b"));

  await installUpdate();
  expect(
    backend.calls
      .map((call) => call.cmd)
      .filter((cmd) => cmd === "ui_state_set" || cmd === "update_install"),
  ).toEqual(["ui_state_set", "update_install"]);
});

test("a refused install says nothing: the state shows the failure", async () => {
  mockBackend({
    update_install: () => {
      throw new Error("the update could not be downloaded: offline");
    },
  });
  render(<Toaster />);
  await installUpdate();
  await act(flush);
  expect(document.body.textContent).not.toContain("offline");
});

test("Skip This Version tells the core and closes the dialog", async () => {
  const backend = mockBackend({ update_skip: () => null });
  useShell.getState().open("updates");
  await skipUpdate("0.10.0");
  expect(backend.callsTo("update_skip")).toEqual([{ version: "0.10.0" }]);
  expect(useShell.getState().dialog).toBeNull();
});
