import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ConnectionState } from "./generated/ConnectionState";
import type { PortForward } from "./generated/PortForward";
import type { StoreWarning } from "./generated/StoreWarning";
import type { SyncWarning } from "./generated/SyncWarning";
import type { ToolProgress } from "./generated/ToolProgress";
import type { UpdateState } from "./generated/UpdateState";
import type { WindowLayout } from "./generated/WindowLayout";
import { windowLabel } from "./window";

function on<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (event) => handler(event.payload));
}

/**
 * Listens to an event the backend sends to one window. Tauri hands a targeted event to
 * every listener that names no target, in every window, so this one names its own.
 */
function onOwn<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (event) => handler(event.payload), {
    target: { kind: "WebviewWindow", label: windowLabel() },
  });
}

export const events = {
  onCatalogChanged: (handler: () => void) =>
    on<unknown>("catalog://changed", () => handler()),
  /** The folder tree or a placement changed; read `api.catalogFolders` again. */
  onCatalogFoldersChanged: (handler: () => void) =>
    on<unknown>("catalog://folders-changed", () => handler()),
  /** A tunnel was added, changed, deleted, or changed state; read `api.tunnelList` again. */
  onTunnelsChanged: (handler: () => void) =>
    on<unknown>("tunnels://changed", () => handler()),
  onClusterState: (
    handler: (change: { id: string; state: ConnectionState }) => void,
  ) => on("cluster://state", handler),
  onKubeconfigWarnings: (handler: (warnings: SyncWarning[]) => void) =>
    on("kubeconfig://warnings", handler),
  onStoreWarning: (handler: (warning: StoreWarning) => void) =>
    on("store://warning", handler),
  /** Carries the whole list after every change. */
  onPortForwardsChanged: (handler: (forwards: PortForward[]) => void) =>
    on("portforward://changed", handler),
  /** A tool download's progress: at most every 200 ms, and at once on each phase change. */
  onToolsProgress: (handler: (progress: ToolProgress) => void) =>
    on("tools://progress", handler),
  /** The whole update state, after every change, to every window. */
  onUpdateState: (handler: (state: UpdateState) => void) =>
    on("update://state", handler),
  /** The macOS menu's app items: `about`, `check_updates`, `preferences`, `palette`, `shortcuts`. Only the focused window gets them. */
  onMenuCommand: (handler: (command: { id: string }) => void) =>
    onOwn("menu://command", handler),
  /**
   * This window's layout as the core now holds it: after a tab moved in or out, or
   * when the core changed a layout this window saved. It replaces the window's layout.
   */
  /**
   * The app is about to quit: save this window's layout now, then answer with
   * `api.windowFlushed` (P34). The app quits without an answer after 500 ms.
   */
  onWindowFlush: (handler: () => void) =>
    onOwn<unknown>("window://flush", () => handler()),
  onWindowLayout: (handler: (layout: WindowLayout) => void) => {
    const label = windowLabel();
    return onOwn<WindowLayout>("window://layout", (layout) => {
      if (layout.label === label) handler(layout);
    });
  },
};
