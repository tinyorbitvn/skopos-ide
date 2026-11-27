import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { UpdateState } from "../../ipc/generated/UpdateState";
import {
  resetPortForwardsForTest,
  usePortForwards,
} from "../../stores/portForwards";
import { resetShellForTest, useShell } from "../../stores/shell";
import { flush, mockBackend } from "../../test/ipc";
import { forward } from "../../test/portForwards";
import { RELEASE, updateState } from "../../test/updates";
import { resetSessionsForTest, useSessions } from "../terminal/sessions";
import { UpdateDialog } from "./UpdateDialog";
import { resetUpdatesForTest, useUpdates } from "./updateStore";

beforeEach(() => {
  resetUpdatesForTest();
  resetShellForTest();
  resetSessionsForTest();
  resetPortForwardsForTest();
});

function show(state: UpdateState | null) {
  const backend = mockBackend({
    open_external: () => null,
    update_check: () => state,
    update_install: () => null,
    update_cancel: () => null,
    update_skip: () => null,
  });
  useUpdates.setState({ state });
  useShell.getState().open("updates");
  render(<UpdateDialog />);
  return backend;
}

const dialog = () => screen.getByTestId("update-dialog");
const buttons = () =>
  within(dialog())
    .getAllByRole("button")
    .map((b) => b.textContent || b.getAttribute("aria-label"));
const available = updateState({
  phase: { type: "available", release: RELEASE },
});

test("while checking, and before the state is read, it says so", () => {
  show(null);
  expect(within(dialog()).getByText("Checking for updates…")).toBeTruthy();
  expect(buttons()).toEqual(["Close"]);
});

test("up to date names the running version", () => {
  show(updateState({ phase: { type: "upToDate" } }));
  expect(
    within(dialog()).getByText("SkoposIDE 0.9.0 is the latest version."),
  ).toBeTruthy();
});

test("an available release shows its notes, its date and the three choices", async () => {
  const backend = show(available);
  expect(
    within(dialog()).getByText("SkoposIDE 0.10.0 is available"),
  ).toBeTruthy();
  expect(
    within(dialog()).getByText("You have 0.9.0 · Released Nov 25, 2026"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("update-notes"))
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["Faster lists", "Fewer clicks"]);
  expect(buttons()).toEqual([
    "Close",
    "Full release notes",
    "Skip This Version",
    "Later",
    "Install and Restart",
  ]);
  expect(screen.queryByTestId("update-will-stop")).toBeNull();
  expect(screen.queryByTestId("update-package")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Full release notes" }));
  await act(flush);
  expect(backend.callsTo("open_external")).toEqual([
    { url: "https://github.com/tinyorbitvn/skopos-ide/releases/tag/v0.10.0" },
  ]);
});

test("Install and Restart installs; Later closes; Skip This Version skips", async () => {
  const backend = show(available);
  fireEvent.click(screen.getByRole("button", { name: "Install and Restart" }));
  await act(flush);
  expect(backend.callsTo("update_install")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Skip This Version" }));
  await act(flush);
  expect(backend.callsTo("update_skip")).toEqual([{ version: "0.10.0" }]);
  expect(useShell.getState().dialog).toBeNull();

  act(() => useShell.getState().open("updates"));
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(useShell.getState().dialog).toBeNull();
});

test("it says what a restart stops in this window", () => {
  useSessions.setState({
    sessions: {
      a: { status: "connected", exitCode: null, tty: true, message: null },
      b: { status: "connecting", exitCode: null, tty: null, message: null },
      c: { status: "ended", exitCode: 0, tty: true, message: null },
    },
  });
  usePortForwards.setState({
    forwards: [forward({ id: "f", state: "running" })],
    loaded: true,
  });
  show(available);
  expect(screen.getByTestId("update-will-stop").textContent).toBe(
    "2 terminals and 1 port forward will stop.",
  );
});

test.each(["deb", "rpm"])(
  "a %s install warns about the password prompt",
  (installer) => {
    show({ ...available, installer });
    expect(screen.getByTestId("update-package").textContent).toBe(
      "You'll be asked for your password to install the package.",
    );
  },
);

test("a copy that cannot update itself says why and offers the download page", async () => {
  const backend = show({
    ...available,
    blocker: "This copy can't update itself.",
  });
  expect(screen.getByTestId("update-blocker").textContent).toBe(
    "This copy can't update itself.",
  );
  expect(buttons()).toEqual([
    "Close",
    "Full release notes",
    "Skip This Version",
    "Later",
    "Open Download Page",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Open Download Page" }));
  await act(flush);
  expect(backend.callsTo("open_external")).toEqual([
    { url: "https://github.com/tinyorbitvn/skopos-ide/releases/latest" },
  ]);
});

test("a download shows its progress and can be cancelled", async () => {
  const backend = show(
    updateState({
      phase: {
        type: "downloading",
        version: "0.10.0",
        received: 4_000_000,
        total: 16_000_000,
      },
    }),
  );
  const bar = screen.getByRole("progressbar", { name: "Downloading 0.10.0" });
  expect(bar.getAttribute("aria-valuenow")).toBe("25");
  expect(within(dialog()).getByText("4.0 of 16.0 MB")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(flush);
  expect(backend.callsTo("update_cancel")).toHaveLength(1);
});

test("a download without a known size moves without a share", () => {
  show(
    updateState({
      phase: {
        type: "downloading",
        version: "0.10.0",
        received: 4_000_000,
        total: null,
      },
    }),
  );
  const bar = screen.getByRole("progressbar", { name: "Downloading 0.10.0" });
  expect(bar.getAttribute("aria-valuenow")).toBeNull();
  expect(within(dialog()).getByText("4.0 MB")).toBeTruthy();
});

test("while installing there is nothing to press and Escape does not close it", () => {
  show(updateState({ phase: { type: "installing", version: "0.10.0" } }));
  expect(within(dialog()).getByText("Installing…")).toBeTruthy();
  expect(within(dialog()).queryAllByRole("button")).toEqual([]);
  fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(useShell.getState().dialog).toBe("updates");
});

test("a failed install offers Try Again, which installs again, and the download page", async () => {
  const backend = show(
    updateState({
      phase: {
        type: "failed",
        message:
          "The update's signature doesn't match, so it wasn't installed.",
        release: RELEASE,
      },
    }),
  );
  expect(within(dialog()).getByText("The update failed")).toBeTruthy();
  expect(within(dialog()).getByRole("alert").textContent).toBe(
    "The update's signature doesn't match, so it wasn't installed.",
  );
  expect(buttons()).toEqual(["Close", "Try Again", "Open Download Page"]);
  fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
  await act(flush);
  expect(backend.callsTo("update_install")).toHaveLength(1);
});

test("a failed check offers Try Again, which checks again", async () => {
  const backend = show(
    updateState({
      phase: {
        type: "failed",
        message: "cannot reach the update server: dns error",
        release: null,
      },
    }),
  );
  expect(within(dialog()).getByText("The check failed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
  await act(flush);
  expect(backend.callsTo("update_check")).toHaveLength(1);
});

test("a Microsoft Store copy says where its updates come from and offers nothing to run", () => {
  show(updateState({ phase: { type: "storeManaged" } }));
  expect(
    within(dialog()).getByText("Updates come from the Microsoft Store"),
  ).toBeTruthy();
  expect(buttons()).toEqual(["Close"]);
});
