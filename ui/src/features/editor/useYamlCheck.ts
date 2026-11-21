import { useEffect, useMemo, useState } from "react";
import { validateYaml, type YamlCheck } from "./validate";

/**
 * Text up to this long is checked as it changes: its parse takes a few milliseconds.
 * A longer one, such as a CRD or a big ConfigMap, would hold up every key typed.
 */
export const CHECK_AT_ONCE_CHARS = 50_000;
/** Longer text is checked this long after its last change. */
export const CHECK_DELAY_MS = 250;

export interface YamlChecked {
  /** The check of the text. While `pending`, the last check made, of an earlier text. */
  check: YamlCheck;
  /** The text has changed since `check` was made, so it must not be sent yet. */
  pending: boolean;
}

/** What a long text shows before its first check: no problem, and nothing to send. */
const NOT_CHECKED: YamlCheck = { ok: true, documents: 1 };

/** The syntax check of the editor's text, made off the typing path when the text is long. */
export function useYamlCheck(text: string): YamlChecked {
  const long = text.length > CHECK_AT_ONCE_CHARS;
  const atOnce = useMemo(
    () => (long ? null : validateYaml(text)),
    [long, text],
  );
  const [late, setLate] = useState<{ text: string; check: YamlCheck } | null>(
    null,
  );
  useEffect(() => {
    if (!long) return;
    const timer = setTimeout(() => {
      setLate({ text, check: validateYaml(text) });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [long, text]);

  if (atOnce) return { check: atOnce, pending: false };
  if (late?.text === text) return { check: late.check, pending: false };
  return { check: late?.check ?? NOT_CHECKED, pending: true };
}
