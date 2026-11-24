import { create } from "zustand";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import { events } from "../../ipc/events";
import type { UpdateState } from "../../ipc/generated/UpdateState";
import { windowLabel } from "../../ipc/window";
import { useShell } from "../../stores/shell";
import { flushUiStateWrites } from "../../stores/uiState";

/** How long the toast that announces a release stays (spec §5.3). */
const TOAST_MS = 10_000;

interface UpdatesState {
  /** The core's update state; null until it was read. */
  state: UpdateState | null;
}

export const useUpdates = create<UpdatesState>(() => ({ state: null }));

let started: Promise<void> | null = null;
/** How many `update://state` events came, so a reply can tell whether one came meanwhile. */
let stateEvents = 0;

/** True in a Microsoft Store copy, which the Store updates (Store spec §3). */
export function useStoreManaged(): boolean {
  return useUpdates((s) => s.state?.phase.type === "storeManaged");
}

/** The same, outside React, for command availability. */
export function isStoreManaged(): boolean {
  return useUpdates.getState().state?.phase.type === "storeManaged";
}

export function openUpdates(): void {
  useShell.getState().open("updates");
}

function received(state: UpdateState): void {
  stateEvents += 1;
  useUpdates.setState({ state });
  // The core names one window for a release's first announcement (R3).
  if (state.toastWindow === windowLabel() && state.phase.type === "available") {
    toast.info(
      `SkoposIDE ${state.phase.release.version} is available`,
      undefined,
      {
        action: { label: "View", onSelect: openUpdates },
        duration: TOAST_MS,
      },
    );
  }
}

async function start(): Promise<void> {
  try {
    await events.onUpdateState(received);
    const now = await api.updateStateGet();
    // An event that came first is newer than this answer.
    if (useUpdates.getState().state === null)
      useUpdates.setState({ state: now });
  } catch {
    // Without the state the status bar shows the version, as before updates existed.
  }
}

/** Reads the state once and follows `update://state`. Later calls share the first one. */
export function initUpdates(): Promise<void> {
  started ??= start();
  return started;
}

/** Check for Updates: opens the dialog, which shows the check and its result (spec §5.4). */
export async function checkForUpdates(): Promise<void> {
  openUpdates();
  const seen = stateEvents;
  try {
    const state = await api.updateCheck();
    // The core also sends every change as update://state, and an event that came while the
    // check ran may be newer than this reply. The reply counts only when no event came.
    if (stateEvents === seen) useUpdates.setState({ state });
  } catch (error) {
    // No state came with the failure, so the dialog would show "checking" forever.
    const phase = useUpdates.getState().state?.phase.type;
    if (phase === undefined || phase === "checking")
      useShell.getState().close("updates");
    toast.error("Could not check for updates", failureMessage(error));
  }
}

/**
 * Install and Restart: saves this window's pending UI state, then downloads and installs.
 * The app restarts when it succeeds. A failure arrives as the `failed` state, which the
 * dialog shows, so the rejection itself says nothing.
 */
export async function installUpdate(): Promise<void> {
  await flushUiStateWrites();
  try {
    await api.updateInstall();
  } catch {
    // Shown by the dialog from the state.
  }
}

export function cancelUpdate(): void {
  void api.updateCancel().catch(() => {});
}

export async function skipUpdate(version: string): Promise<void> {
  try {
    await api.updateSkip(version);
    useShell.getState().close("updates");
  } catch (error) {
    toast.error("Could not skip this version", failureMessage(error));
  }
}

export function resetUpdatesForTest(): void {
  started = null;
  stateEvents = 0;
  useUpdates.setState({ state: null });
}
