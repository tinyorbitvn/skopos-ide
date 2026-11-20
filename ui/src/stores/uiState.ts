import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../ipc/api";
import type { JsonValue } from "../ipc/generated/serde_json/JsonValue";

const SAVE_DELAY_MS = 300;

/**
 * Values this window changed that the backend has not confirmed saving. The backend may
 * answer a read sent after a write before it saves the write, so a reader mounted in
 * the meantime takes the value from here instead: a list opened right after a filter
 * changed on another one keeps that filter. Once saved, the entry goes and readers ask
 * the backend again, which another window may have changed since.
 */
const unsaved = new Map<string, { value: unknown }>();

/** The flush of every mounted state, so the app can save them all before it restarts. */
const flushers = new Set<() => void>();
/** Writes sent to the backend and not answered yet. */
const inFlight = new Set<Promise<unknown>>();

/**
 * Saves every pending write now and resolves once the backend answered them all. The
 * app calls it before it restarts into an update (in-app update R4).
 */
export async function flushUiStateWrites(): Promise<void> {
  for (const flush of [...flushers]) flush();
  await Promise.all([...inFlight]);
}

/**
 * A value kept between runs. It shows `initial` until the saved one arrives, unless
 * it was changed by then. Writes are saved after 300 ms without another change,
 * and a pending write is saved when the component goes away. The third value is
 * true once the saved value was read, or found missing or unreadable.
 */
export function useUiState<T>(
  key: string,
  initial: T,
): [T, (v: T) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  // The key whose saved value was read (or found missing), so `loaded` resets with the key.
  const [readKey, setReadKey] = useState<string | null>(null);
  const changed = useRef(false);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) {
      const write: Promise<void> = api
        .uiStateSet(key, next.value as JsonValue)
        .catch(() => {})
        .finally(() => {
          // A newer change of the key keeps its own entry.
          if (unsaved.get(key) === next) unsaved.delete(key);
          inFlight.delete(write);
        });
      inFlight.add(write);
    }
  }, [key]);

  useEffect(() => {
    flushers.add(flush);
    changed.current = false;
    let current = true;
    const local = unsaved.get(key);
    if (local) setValue(local.value as T);
    api
      .uiStateGet(key)
      .then((saved) => {
        if (current && !changed.current && !local && saved !== null) {
          setValue(saved as T);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (current) setReadKey(key);
      });
    return () => {
      current = false;
      flushers.delete(flush);
      flush();
    };
  }, [key, flush]);

  const set = useCallback(
    (next: T) => {
      changed.current = true;
      setValue(next);
      const entry = { value: next };
      pending.current = entry;
      unsaved.set(key, entry);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [key, flush],
  );

  return [value, set, readKey === key];
}
