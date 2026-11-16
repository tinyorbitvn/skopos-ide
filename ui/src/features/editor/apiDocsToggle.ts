import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../../ipc/api";

/** The `ui_state` key of the API docs toggle, which every YAML tab shares (spec L17). */
export const API_DOCS_KEY = "editor.apiDocs";

interface ApiDocsToggle {
  /** Whether the API docs show; true until a saved false or a click says otherwise. */
  shown: boolean;
  /** True once the saved value was read, found missing or unreadable, or the user chose. */
  read: boolean;
  /** True once the user chose, which a late read does not undo. */
  chosen: boolean;
}

const FIRST: ApiDocsToggle = { shown: true, read: false, chosen: false };

const useToggle = create<ApiDocsToggle>(() => FIRST);

let reading: Promise<void> | null = null;

/** Reads the saved value once per run. Anything but a boolean leaves the default. */
function readOnce(): void {
  if (reading) return;
  reading = api
    .uiStateGet(API_DOCS_KEY)
    .then(
      (saved) => {
        if (!useToggle.getState().chosen && typeof saved === "boolean") {
          useToggle.setState({ shown: saved });
        }
      },
      () => {},
    )
    .finally(() => useToggle.setState({ read: true }));
}

/** Shows or hides the API docs in every tab, and saves the choice at once. */
export function setApiDocsShown(shown: boolean): void {
  useToggle.setState({ shown, read: true, chosen: true });
  void api.uiStateSet(API_DOCS_KEY, shown).catch(() => {});
}

/** Whether the API docs show, the setter, and whether that is known yet. */
export function useApiDocsShown(): [
  boolean,
  (shown: boolean) => void,
  boolean,
] {
  const shown = useToggle((state) => state.shown);
  const read = useToggle((state) => state.read);
  useEffect(readOnce, []);
  return [shown, setApiDocsShown, read];
}

export function resetApiDocsToggleForTest(): void {
  reading = null;
  useToggle.setState(FIRST);
}
