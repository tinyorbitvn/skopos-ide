import { type ReactNode, useId, useState } from "react";
import {
  Button,
  ErrorNotice,
  IconButton,
  Input,
  Segmented,
} from "../../design";
import { RotateCcw, Trash2 } from "../../design/icons";
import styles from "./config.module.css";
import {
  convertText,
  type DataEditState,
  isValidDataKey,
  rawHint,
  type ValueForm,
  valueError,
} from "./dataEdits";

const INVALID_KEY = "A key may hold only letters, digits, `.`, `-` and `_`.";
const MAX_ROWS = 12;

/** A key's text box, as tall as its text up to a limit, with any error under it. */
export function ValueInput(props: {
  label: string;
  testId: string;
  value: string;
  readOnly?: boolean;
  error?: string;
  onChange(value: string): void;
}) {
  const errorId = useId();
  return (
    <>
      <textarea
        className={
          props.error ? `${styles.input} ${styles.invalid}` : styles.input
        }
        aria-label={props.label}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? errorId : undefined}
        data-testid={props.testId}
        rows={Math.min(props.value.split("\n").length + 1, MAX_ROWS)}
        spellCheck={false}
        readOnly={props.readOnly}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.error ? (
        <span id={errorId} role="alert" className={styles.error}>
          {props.error}
        </span>
      ) : null}
    </>
  );
}

/**
 * Raw | Base64 for one value's text. Choosing the other form hands over the
 * text converted to it; Raw is offered only for base64 of UTF-8 text.
 */
export function FormSwitch(props: {
  label: string;
  testId: string;
  form: ValueForm;
  text: string;
  disabled?: boolean;
  onChange(form: ValueForm, text: string): void;
}) {
  const hint = rawHint(props.form, props.text);
  return (
    <Segmented
      label={props.label}
      size="sm"
      value={props.form}
      testId={props.testId}
      options={[
        {
          value: "raw",
          label: "Raw",
          disabled: props.disabled || hint !== undefined,
          hint,
        },
        { value: "base64", label: "Base64", disabled: props.disabled },
      ]}
      onChange={(form) => props.onChange(form, convertText(props.text, form))}
    />
  );
}

/** One key: its name, its actions and a Remove icon, then its value unless removed. */
export function DataRow(props: {
  name: string;
  edits: DataEditState;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { name, edits } = props;
  const removed = edits.isRemoved(name);
  return (
    <li className={styles.row}>
      <div className={styles.head}>
        <code className={removed ? styles.removedKey : styles.key}>{name}</code>
        <span className={styles.actions}>
          {removed ? null : props.actions}
          <IconButton
            label={removed ? `Undo remove ${name}` : `Remove ${name}`}
            icon={
              removed ? (
                <RotateCcw size={16} aria-hidden="true" />
              ) : (
                <Trash2 size={16} aria-hidden="true" />
              )
            }
            disabled={edits.saving}
            data-testid={`data-remove-${name}`}
            onClick={() =>
              removed ? edits.undoRemove(name) : edits.remove(name)
            }
          />
        </span>
      </div>
      {removed ? null : props.children}
    </li>
  );
}

function ServerNotices({ edits }: { edits: DataEditState }) {
  const reload = (
    <Button
      size="sm"
      disabled={edits.saving}
      data-testid="data-reload"
      onClick={edits.reload}
    >
      Reload
    </Button>
  );
  if (edits.conflict) {
    return (
      <div className={styles.notice} role="alert" data-testid="data-conflict">
        <span>
          This object changed on the server, so it was not saved. Your text is
          kept.
        </span>
        {reload}
      </div>
    );
  }
  if (edits.changedOnServer) {
    return (
      <div
        className={styles.notice}
        role="status"
        data-testid="data-changed-on-server"
      >
        <span>This object changed on the server.</span>
        {reload}
      </div>
    );
  }
  return null;
}

/** The add row, the notices and Save, below the keys of either panel. */
export function DataControls(props: {
  edits: DataEditState;
  /** Names a new key may not take, beyond those being edited. */
  reservedKeys?: string[];
  /**
   * Offers a new value as raw text or as base64, and learns the form each key
   * is added in. Without it, a new value is text.
   */
  onAddInForm?(key: string, form: ValueForm): void;
  /** Some text cannot be saved as it is. */
  invalid?: boolean;
}) {
  const { edits, reservedKeys = [], onAddInForm, invalid = false } = props;
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newForm, setNewForm] = useState<ValueForm>("raw");
  const valid = isValidDataKey(newKey);
  const valueProblem = valueError(newForm, newValue);
  const canAdd =
    valid &&
    edits.isNewKey(newKey) &&
    !reservedKeys.includes(newKey) &&
    !valueProblem;
  return (
    <div className={styles.controls}>
      <div className={styles.addRow}>
        <Input
          label="New key"
          value={newKey}
          spellCheck={false}
          error={newKey !== "" && !valid ? INVALID_KEY : undefined}
          readOnly={edits.saving}
          data-testid="data-new-key"
          onChange={(e) => setNewKey(e.target.value)}
        />
        {onAddInForm ? (
          <FormSwitch
            label="Encoding of new value"
            testId="data-new-form"
            form={newForm}
            text={newValue}
            disabled={edits.saving}
            onChange={(form, text) => {
              setNewForm(form);
              setNewValue(text);
            }}
          />
        ) : null}
        <ValueInput
          label="New value"
          testId="data-new-value"
          value={newValue}
          readOnly={edits.saving}
          error={valueProblem}
          onChange={setNewValue}
        />
        <Button
          size="sm"
          disabled={!canAdd || edits.saving}
          data-testid="data-add"
          onClick={() => {
            onAddInForm?.(newKey, newForm);
            edits.setText(newKey, newValue);
            setNewKey("");
            setNewValue("");
            setNewForm("raw");
          }}
        >
          Add
        </Button>
      </div>
      <ServerNotices edits={edits} />
      {edits.saveError ? (
        <ErrorNotice title="Save failed" message={edits.saveError} />
      ) : null}
      <div>
        <Button
          variant="primary"
          loading={edits.saving}
          disabled={!edits.dirty || invalid}
          data-testid="data-save"
          onClick={() => void edits.save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
