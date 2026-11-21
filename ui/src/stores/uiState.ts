import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../ipc/api";
import type { JsonValue } from "../ipc/generated/serde_json/JsonValue";

const SAVE_DELAY_MS = 300;

/**
 * What this window saved last under each key: the value, how many times it saved one,
 * and how many of those writes are not done. The backend answers a read with the value
 * from before until a write is done, so a reader that starts or is under way meanwhile
 * takes the value from here. Without it a table opened right after its namespace filter
 * changed would show every namespace.
 */
const written = new Map<
  string,
  { value: unknown; count: number; pending: number }
>();

function save(key: string, value: unknown): void {
  const own = written.get(key) ?? { value, count: 0, pending: 0 };
  own.value = value;
  own.count += 1;
  own.pending += 1;
  written.set(key, own);
  const done = () => {
    own.pending -= 1;
  };
  api.uiStateSet(key, value as JsonValue).then(done, done);
}

/** Forgets what this window saved, so one test's writes do not reach the next. */
export function resetUiStateForTest(): void {
  written.clear();
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
    if (next) save(key, next.value);
  }, [key]);

  useEffect(() => {
    changed.current = false;
    let current = true;
    const before = written.get(key);
    const savesBefore = before?.count ?? 0;
    if (before !== undefined && before.pending > 0) {
      setValue(before.value as T);
      setReadKey(key);
    } else {
      api
        .uiStateGet(key)
        .then((saved) => {
          if (!current || changed.current) return;
          const own = written.get(key);
          if (own !== undefined && own.count !== savesBefore) {
            setValue(own.value as T);
          } else if (saved !== null) {
            setValue(saved as T);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (current) setReadKey(key);
        });
    }
    return () => {
      current = false;
      flush();
    };
  }, [key, flush]);

  const set = useCallback(
    (next: T) => {
      changed.current = true;
      setValue(next);
      pending.current = { value: next };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  return [value, set, readKey === key];
}
