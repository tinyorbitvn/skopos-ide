import * as RT from "@radix-ui/react-toast";
import { useSyncExternalStore } from "react";
import styles from "./Toast.module.css";

type Kind = "success" | "error" | "info";
/** A button in the toast, such as View. Choosing it closes the toast. */
export interface ToastAction {
  label: string;
  onSelect(): void;
}
export interface ToastOptions {
  action?: ToastAction;
  /** In milliseconds; otherwise the kind's own. */
  duration?: number;
}
interface Item {
  id: number;
  kind: Kind;
  message: string;
  details?: string;
  action?: ToastAction;
  duration?: number;
}

let items: Item[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function push(
  kind: Kind,
  message: string,
  details?: string,
  options?: ToastOptions,
): void {
  items = [
    ...items,
    {
      id: nextId++,
      kind,
      message,
      details,
      action: options?.action,
      duration: options?.duration,
    },
  ];
  emit();
}
function dismiss(id: number): void {
  items = items.filter((i) => i.id !== id);
  emit();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** One line per failed object: more than can be read before a timer runs out. */
function isList(details: string | undefined): boolean {
  return details?.includes("\n") ?? false;
}

function durationOf(item: Item): number {
  if (isList(item.details)) return Number.POSITIVE_INFINITY;
  if (item.duration !== undefined) return item.duration;
  return item.kind === "error" ? 10000 : 4000;
}

export const toast = {
  success: (m: string, details?: string, options?: ToastOptions) =>
    push("success", m, details, options),
  error: (m: string, details?: string, options?: ToastOptions) =>
    push("error", m, details, options),
  info: (m: string, details?: string, options?: ToastOptions) =>
    push("info", m, details, options),
};

export function Toaster() {
  const current = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
  return (
    <RT.Provider swipeDirection="right">
      {current.map((t) => (
        <RT.Root
          key={t.id}
          className={`${styles.toast} ${styles[t.kind]}`}
          duration={durationOf(t)}
          data-testid="toast"
          onOpenChange={(o) => {
            if (!o) dismiss(t.id);
          }}
        >
          <RT.Title className={styles.title}>{t.message}</RT.Title>
          {t.details ? (
            <RT.Description
              className={styles.details}
              tabIndex={isList(t.details) ? 0 : undefined}
            >
              {t.details}
            </RT.Description>
          ) : null}
          {t.action ? (
            <RT.Action
              className={styles.action}
              altText={t.action.label}
              onClick={t.action.onSelect}
            >
              {t.action.label}
            </RT.Action>
          ) : null}
          <RT.Close className={styles.close} aria-label="Dismiss">
            ×
          </RT.Close>
        </RT.Root>
      ))}
      <RT.Viewport className={styles.viewport} />
    </RT.Provider>
  );
}
