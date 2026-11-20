import { useState } from "react";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { DataChange } from "../../ipc/generated/DataChange";
import { useUnsavedEdits } from "../detail/unsavedEdits";

const DATA_KEY = /^[-._a-zA-Z0-9]{1,253}$/;

export function isValidDataKey(key: string): boolean {
  return DATA_KEY.test(key);
}

/** Whether two texts of a key hold the same value. */
export type SameValue = (
  key: string,
  original: string,
  edited: string,
) => boolean;

const sameText: SameValue = (_key, original, edited) => original === edited;

/** What turns `original` into `edited`, by key. A `null` value removes the key. */
export function dataChanges(
  original: Record<string, string>,
  edited: Record<string, string>,
  same: SameValue = sameText,
): DataChange[] {
  const keys = [
    ...new Set([...Object.keys(original), ...Object.keys(edited)]),
  ].sort();
  const changes: DataChange[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(edited, key)) {
      changes.push({ key, value: null });
    } else if (
      !Object.hasOwn(original, key) ||
      !same(key, original[key], edited[key])
    ) {
      changes.push({ key, value: edited[key] });
    }
  }
  return changes;
}

/** The string entries of a `data` field, which an object may lack or malform. */
export function dataOf(field: unknown): Record<string, string> {
  if (!field || typeof field !== "object" || Array.isArray(field)) return {};
  return Object.fromEntries(
    Object.entries(field).filter(([, value]) => typeof value === "string"),
  );
}

export function keyCount(field: unknown): number {
  return Object.keys(dataOf(field)).length;
}

/** How a value's text is typed: as itself, or as the base64 of its bytes. */
export type ValueForm = "raw" | "base64";

export const NOT_BASE64 = "Not valid base64.";
export const BINARY_HINT = "Binary value: edit it as base64.";

/** The ASCII whitespace base64 may hold, the same the core ignores. */
const BASE64_SPACE = /[\t\n\f\r ]/g;

/** The standard base64 of the text's UTF-8 bytes. */
export function textToBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * The bytes standard base64 encodes, whitespace aside, or `null` for anything
 * else, missing padding included, as the core refuses it too.
 */
export function base64Bytes(text: string): Uint8Array | null {
  const compact = text.replace(BASE64_SPACE, "");
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    return null;
  }
  if (btoa(binary) !== compact) return null;
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The text base64 encodes, or `null` when it is not base64 of UTF-8 bytes. */
export function base64ToText(text: string): string | null {
  const bytes = base64Bytes(text);
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

/** Whether two texts in one form hold the same value. */
export function sameValue(form: ValueForm, a: string, b: string): boolean {
  if (a === b) return true;
  // Valid base64 without its whitespace is the one way to write its bytes.
  return (
    form === "base64" &&
    base64Bytes(a) !== null &&
    a.replace(BASE64_SPACE, "") === b.replace(BASE64_SPACE, "")
  );
}

/** The text in the other form; text that does not convert stays as it is. */
export function convertText(text: string, to: ValueForm): string {
  return to === "base64" ? textToBase64(text) : (base64ToText(text) ?? text);
}

/** What is wrong with the text in this form, if anything. */
export function valueError(form: ValueForm, text: string): string | undefined {
  return form === "base64" && !base64Bytes(text) ? NOT_BASE64 : undefined;
}

/** Why Raw cannot be chosen for this text in this form, if it cannot. */
export function rawHint(form: ValueForm, text: string): string | undefined {
  if (form === "raw") return undefined;
  if (!base64Bytes(text)) return NOT_BASE64;
  return base64ToText(text) === null ? BINARY_HINT : undefined;
}

interface Baseline {
  version: string;
  data: Record<string, string>;
}

interface Edits {
  /** The text per key: an edited key, or an added one when not in the baseline. */
  values: Record<string, string>;
  /** Keys of the baseline marked for removal. */
  removed: string[];
}

const NO_EDITS: Edits = { values: {}, removed: [] };

export interface DataEditState {
  /** Replaced each time the edit starts over from another state of the object. */
  baseline: Baseline;
  /** Every key to list: the baseline's and the added ones, sorted. */
  keys: string[];
  dirty: boolean;
  saving: boolean;
  /** The save was refused because the object changed. */
  conflict: boolean;
  /** Why the save failed, for any failure but a conflict. */
  saveError: string | null;
  changedOnServer: boolean;
  /** The current text of a key that is not removed. */
  textOf(key: string): string;
  /** Whether the key has text of its own rather than the baseline's. */
  hasText(key: string): boolean;
  inBaseline(key: string): boolean;
  isRemoved(key: string): boolean;
  /** Whether a key can be added under this name. */
  isNewKey(key: string): boolean;
  setText(key: string, text: string): void;
  /** Goes back to the baseline for this key's text. */
  dropText(key: string): void;
  /** Marks a baseline key for removal, or forgets an added one. */
  remove(key: string): void;
  undoRemove(key: string): void;
  reload(): void;
  save(): Promise<void>;
}

/**
 * The edit state both data panels share. While nothing is dirty the baseline
 * follows the live object; once dirty it stays where the edit started, so that
 * a live update cannot overwrite what is being typed.
 */
export function useDataEdits(options: {
  version: string;
  data: Record<string, string>;
  /** Values known beyond `data`, compared against as if they were the baseline's. */
  revealed?: Record<string, string>;
  /** Whether a key's text holds its original value; plain equality by default. */
  same?: SameValue;
  send(version: string, changes: DataChange[]): Promise<void>;
  /** What the baseline holds after a save, in place of the saved values. */
  afterSave?(saved: Record<string, string>): Record<string, string>;
}): DataEditState {
  const { version, data, revealed, same, send, afterSave } = options;
  const [baseline, setBaseline] = useState<Baseline>({ version, data });
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{
    conflict: boolean;
    message: string;
  } | null>(null);

  const original = { ...baseline.data, ...revealed };
  const edited = Object.fromEntries(
    Object.entries({ ...original, ...edits.values }).filter(
      ([key]) => !edits.removed.includes(key),
    ),
  );
  const changes = dataChanges(original, edited, same);
  const dirty = changes.length > 0;
  useUnsavedEdits(dirty);

  if (!dirty) {
    if (baseline.version !== version) {
      setBaseline({ version, data });
      setEdits(NO_EDITS);
    }
    if (failure) setFailure(null);
  }

  const inBaseline = (key: string) => Object.hasOwn(baseline.data, key);
  const hasText = (key: string) => Object.hasOwn(edits.values, key);
  const isRemoved = (key: string) => edits.removed.includes(key);
  const dropValue = (values: Edits["values"], key: string) => {
    const { [key]: _dropped, ...rest } = values;
    return rest;
  };

  return {
    baseline,
    keys: [
      ...new Set([...Object.keys(baseline.data), ...Object.keys(edits.values)]),
    ].sort(),
    dirty,
    saving,
    conflict: failure?.conflict ?? false,
    saveError: failure && !failure.conflict ? failure.message : null,
    changedOnServer: dirty && !saving && baseline.version !== version,
    textOf: (key) => (Object.hasOwn(edited, key) ? edited[key] : ""),
    hasText,
    inBaseline,
    isRemoved,
    isNewKey: (key) => !inBaseline(key) && !hasText(key),
    setText: (key, text) =>
      setEdits((e) => ({ ...e, values: { ...e.values, [key]: text } })),
    dropText: (key) =>
      setEdits((e) => ({ ...e, values: dropValue(e.values, key) })),
    remove: (key) =>
      setEdits((e) => ({
        values: dropValue(e.values, key),
        removed: inBaseline(key) ? [...e.removed, key] : e.removed,
      })),
    undoRemove: (key) =>
      setEdits((e) => ({
        ...e,
        removed: e.removed.filter((k) => k !== key),
      })),
    reload: () => {
      setBaseline({ version, data });
      setEdits(NO_EDITS);
      setFailure(null);
    },
    save: async () => {
      setSaving(true);
      setFailure(null);
      try {
        await send(baseline.version, changes);
        setBaseline({
          version: baseline.version,
          data: afterSave ? afterSave(edited) : edited,
        });
        setEdits(NO_EDITS);
      } catch (error) {
        setFailure({
          conflict: error instanceof IpcFailure && error.code === "Conflict",
          message: failureMessage(error),
        });
      } finally {
        setSaving(false);
      }
    },
  };
}
