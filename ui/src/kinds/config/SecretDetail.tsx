import { useRef, useState } from "react";
import { ErrorNotice, IconButton } from "../../design";
import { Eye, EyeOff } from "../../design/icons";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { SecretValue } from "../../ipc/generated/SecretValue";
import { Part } from "../detail/parts";
import { objectKey } from "../objects";
import type { DetailProps } from "../registry";
import styles from "./config.module.css";
import { DataControls, DataRow, FormSwitch, ValueInput } from "./DataControls";
import {
  dataOf,
  sameValue,
  textToBase64,
  useDataEdits,
  type ValueForm,
  valueError,
} from "./dataEdits";

const MASK = "••••••";

/** Revealed values live only here, in this component's state. */
interface RevealState {
  values: Map<string, SecretValue>;
  /** The request that may still fill in a key; any other answer is dropped. */
  pending: Map<string, number>;
  error: { key: string; message: string } | null;
}

const MASKED: RevealState = {
  values: new Map(),
  pending: new Map(),
  error: null,
};

function without<V>(map: Map<string, V>, key: string): Map<string, V> {
  const copy = new Map(map);
  copy.delete(key);
  return copy;
}

function blankValues(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(data).map((key) => [key, ""]));
}

/** A revealed value as text in this form. */
function revealedIn(form: ValueForm, value: SecretValue): string {
  return form === "base64" && !value.binary
    ? textToBase64(value.value)
    : value.value;
}

function SecretPanel({ clusterId, object }: DetailProps) {
  const namespace = object.metadata.namespace ?? "";
  const name = object.metadata.name;
  const [reveal, setReveal] = useState<RevealState>(MASKED);
  /** The form chosen per key; a key without one is in its first form. */
  const [forms, setForms] = useState<Map<string, ValueForm>>(new Map());
  const lastRequest = useRef(0);
  const formOf = (key: string): ValueForm =>
    forms.get(key) ?? (reveal.values.get(key)?.binary ? "base64" : "raw");
  const edits = useDataEdits({
    version: object.metadata.resourceVersion ?? "",
    data: blankValues(dataOf(object.data)),
    revealed: Object.fromEntries(
      [...reveal.values].map(([key, value]) => [
        key,
        revealedIn(formOf(key), value),
      ]),
    ),
    // No raw text holds a binary value, not even its base64 typed as text.
    same: (key, original, edited) =>
      !(formOf(key) === "raw" && reveal.values.get(key)?.binary) &&
      sameValue(formOf(key), original, edited),
    send: (version, changes) =>
      api.secretUpdate(
        clusterId,
        namespace,
        name,
        version,
        changes.map(({ key, value }) => ({
          key,
          value:
            value === null
              ? null
              : formOf(key) === "base64"
                ? { base64: value }
                : { text: value },
        })),
      ),
    afterSave: blankValues,
  });

  // A new baseline means a save, a reload or a change on the server, after
  // which what was revealed may be stale.
  const [maskedAt, setMaskedAt] = useState(edits.baseline);
  if (maskedAt !== edits.baseline) {
    setMaskedAt(edits.baseline);
    setReveal((r) => ({ ...MASKED, error: r.error }));
    setForms(new Map());
  }

  /** Whether the key's text is here to edit: revealed, or added. */
  const known = (key: string) =>
    reveal.values.has(key) || !edits.inBaseline(key);
  const invalid = edits.keys.some(
    (key) =>
      known(key) &&
      !edits.isRemoved(key) &&
      valueError(formOf(key), edits.textOf(key)) !== undefined,
  );

  const switchForm = (key: string, form: ValueForm, text: string) => {
    edits.setText(key, text);
    setForms((f) => new Map(f).set(key, form));
  };

  const hide = (key: string) => {
    edits.dropText(key);
    setForms((f) => without(f, key));
    setReveal((r) => ({
      ...r,
      values: without(r.values, key),
      pending: without(r.pending, key),
    }));
  };

  const startReveal = (key: string) => {
    lastRequest.current += 1;
    const request = lastRequest.current;
    setReveal((r) => ({
      ...r,
      pending: new Map(r.pending).set(key, request),
      error: null,
    }));
    const settle = (change: (r: RevealState) => Partial<RevealState>) =>
      setReveal((r) =>
        r.pending.get(key) === request
          ? { ...r, pending: without(r.pending, key), ...change(r) }
          : r,
      );
    api.secretReveal(clusterId, namespace, name, key).then(
      (value) => settle((r) => ({ values: new Map(r.values).set(key, value) })),
      (error) =>
        settle(() => ({ error: { key, message: failureMessage(error) } })),
    );
  };

  return (
    <Part title="Data">
      {edits.keys.length === 0 ? (
        <p className={styles.muted}>No data.</p>
      ) : null}
      {reveal.error ? (
        <ErrorNotice
          title={`Could not reveal ${reveal.error.key}`}
          message={reveal.error.message}
        />
      ) : null}
      <ul className={styles.rows}>
        {edits.keys.map((key) => {
          const open = reveal.values.has(key) || reveal.pending.has(key);
          const form = formOf(key);
          const text = edits.textOf(key);
          return (
            <DataRow
              key={key}
              name={key}
              edits={edits}
              actions={
                <>
                  {known(key) ? (
                    <FormSwitch
                      label={`Encoding of ${key}`}
                      testId={`secret-form-${key}`}
                      form={form}
                      text={text}
                      disabled={edits.saving}
                      onChange={(next, converted) =>
                        switchForm(key, next, converted)
                      }
                    />
                  ) : null}
                  {edits.inBaseline(key) ? (
                    <IconButton
                      label={open ? `Hide ${key}` : `Reveal ${key}`}
                      icon={
                        open ? (
                          <EyeOff size={16} aria-hidden="true" />
                        ) : (
                          <Eye size={16} aria-hidden="true" />
                        )
                      }
                      disabled={edits.saving}
                      data-testid={`secret-reveal-${key}`}
                      onClick={() => (open ? hide(key) : startReveal(key))}
                    />
                  ) : null}
                </>
              }
            >
              {known(key) ? (
                <ValueInput
                  label={`Value of ${key}`}
                  testId={`secret-input-${key}`}
                  value={text}
                  readOnly={edits.saving}
                  error={valueError(form, text)}
                  onChange={(typed) => edits.setText(key, typed)}
                />
              ) : (
                <button
                  type="button"
                  className={styles.masked}
                  aria-label={`Reveal ${key}`}
                  disabled={edits.saving}
                  data-testid={`secret-value-${key}`}
                  onClick={() => {
                    if (!open) startReveal(key);
                  }}
                >
                  {MASK}
                </button>
              )}
            </DataRow>
          );
        })}
      </ul>
      <DataControls
        edits={edits}
        invalid={invalid}
        onAddInForm={(key, form) => setForms((f) => new Map(f).set(key, form))}
      />
    </Part>
  );
}

/** Remounts per object, which drops every revealed value. */
export function SecretDetail(props: DetailProps) {
  return <SecretPanel key={objectKey(props.object)} {...props} />;
}
