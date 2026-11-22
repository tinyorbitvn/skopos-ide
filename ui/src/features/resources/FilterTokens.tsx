import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../../design/Button";
import { Input } from "../../design/Input";
import { ChevronDown, X } from "../../design/icons";
import { Segmented } from "../../design/Segmented";
import styles from "./FilterTokens.module.css";
import {
  columnOf,
  type FilterContext,
  type FilterJoin,
  type FilterOperator,
  filterText,
  measureHint,
  measureValue,
  NO_COLUMNS,
  type ObjectFilter,
  OPERATORS,
  operatorName,
  operatorsOf,
  propertyText,
  propertyWords,
  takesAnyValue,
} from "./filter";

/** A token shows this many characters of its value, then an ellipsis (spec M18). */
export const TOKEN_VALUE_CHARS = 48;

/** The operator choices' values, so their test ids stay kebab-case. */
const OPERATOR_IDS: Record<FilterOperator, string> = {
  "=": "equals",
  "!=": "not-equals",
  ":": "contains",
  "!:": "not-contains",
  ">": "greater",
  "<": "less",
};

function operatorOf(id: string): FilterOperator {
  const found = OPERATORS.find((o) => OPERATOR_IDS[o.operator] === id);
  return found?.operator ?? ":";
}

/** `text`, cut after `max` characters with an ellipsis. */
export function cutText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/**
 * The token an edit gives, null when the edit removes it, or "invalid": an empty value
 * removes it, except for `:` or `!:` on a label, an annotation or a column, where it means
 * any value (spec M19); `>` and `<` need a number or a time (column filter spec §3.5).
 */
export function editedFilter(
  filter: ObjectFilter,
  operator: FilterOperator,
  value: string,
  context: FilterContext = NO_COLUMNS,
): ObjectFilter | null | "invalid" {
  const trimmed = value.trim();
  if (operator === ">" || operator === "<") {
    if (trimmed === "") return null;
    // A column that left the list cannot say whether it counts or times, so the
    // value stays as typed; the token matches again once the column is back.
    const missing =
      filter.property.type === "column" &&
      columnOf(filter.property, context) === undefined;
    return !missing && measureValue(filter.property, trimmed, context) === null
      ? "invalid"
      : { property: filter.property, operator, value: trimmed };
  }
  if (trimmed === "" && !takesAnyValue(filter.property, operator)) return null;
  return { property: filter.property, operator, value: trimmed };
}

export interface FilterTokensProps {
  tokens: readonly ObjectFilter[];
  onTokensChange(tokens: ObjectFilter[]): void;
  join: FilterJoin;
  onJoinChange(join: FilterJoin): void;
  /** Removes every token and the text. */
  onClear(): void;
  /** Objects that pass, and objects after the namespace filter (spec M18). */
  shown: number;
  total: number;
  /** Puts focus back in the filter box. */
  onFocusBox(): void;
  /** The list's columns, for a column token's operators and header (column filter spec §3.5). */
  context: FilterContext;
}

/**
 * The row of tokens under the toolbar (spec M18): each token with its edit and remove
 * buttons, the join between them, Clear filters and the count. Nothing shows without a
 * token. A token's edit button opens the edit panel (spec M19).
 */
export function FilterTokens(props: FilterTokensProps): ReactElement | null {
  const { tokens, join } = props;
  const [editing, setEditing] = useState<number | null>(null);
  const editButtons = useRef<(HTMLButtonElement | null)[]>([]);

  if (tokens.length === 0) return null;

  const otherJoin: FilterJoin = join === "and" ? "or" : "and";
  const joinTitle =
    join === "and"
      ? "Rows match every filter. Click to match any filter."
      : "Rows match any filter. Click to match every filter.";

  const remove = (at: number) => {
    setEditing(null);
    props.onTokensChange(tokens.filter((_, i) => i !== at));
    props.onFocusBox();
  };

  /** Closes the panel; focus goes back to the token, or to the box when it is gone. */
  const finish = (at: number, result: ObjectFilter | null | "cancel") => {
    setEditing(null);
    if (result === "cancel") {
      editButtons.current[at]?.focus();
    } else if (result === null) {
      props.onTokensChange(tokens.filter((_, i) => i !== at));
      props.onFocusBox();
    } else {
      props.onTokensChange(tokens.map((t, i) => (i === at ? result : t)));
      editButtons.current[at]?.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that the row of tokens does not want.
    <div
      role="group"
      aria-label="Filters"
      className={styles.tokens}
      data-testid="filter-tokens"
    >
      {tokens.map((token, i) => {
        const text = filterText(token);
        const missing =
          token.property.type === "column" &&
          !props.context.byKey.has(token.property.key);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity but their place; two tokens may be equal.
          <span key={i} className={styles.item}>
            {i > 0 ? (
              <button
                type="button"
                className={styles.join}
                title={joinTitle}
                data-testid={`filter-join-${i}`}
                onClick={() => props.onJoinChange(otherJoin)}
              >
                {join}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            ) : null}
            <span className={styles.wrap} data-filter-token={i}>
              <span
                className={styles.token}
                data-editing={editing === i}
                data-missing={missing}
                title={
                  missing && token.property.type === "column"
                    ? `This list has no column ${token.property.key}`
                    : undefined
                }
                data-testid={`filter-token-${i}`}
              >
                <button
                  ref={(el) => {
                    editButtons.current[i] = el;
                  }}
                  type="button"
                  className={styles.body}
                  aria-label={`Edit filter ${text}`}
                  aria-haspopup="dialog"
                  aria-expanded={editing === i}
                  data-testid={`filter-token-edit-${i}`}
                  onClick={() => setEditing(editing === i ? null : i)}
                >
                  <TokenFace filter={token} />
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove filter ${text}`}
                  title="Remove filter"
                  data-testid={`filter-token-remove-${i}`}
                  onClick={() => remove(i)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
              {editing === i ? (
                <FilterEdit
                  filter={token}
                  anchor={i}
                  context={props.context}
                  onDone={(result) => finish(i, result)}
                />
              ) : null}
            </span>
          </span>
        );
      })}
      <button
        type="button"
        className={styles.clear}
        data-testid="filter-clear"
        onClick={() => {
          setEditing(null);
          props.onClear();
          props.onFocusBox();
        }}
      >
        Clear filters
      </button>
      <span className={styles.count} data-testid="filter-count">
        {props.shown} of {props.total}
      </span>
    </div>
  );
}

/** A token's face: the property, the operator and the value (spec M18). */
function TokenFace({ filter }: { filter: ObjectFilter }): ReactElement {
  const value =
    filter.value === "" ? (
      <span className={styles.any}>any value</span>
    ) : (
      <span className={styles.value} title={filter.value}>
        {filter.property.type === "text"
          ? `"${cutText(filter.value, TOKEN_VALUE_CHARS)}"`
          : cutText(filter.value, TOKEN_VALUE_CHARS)}
      </span>
    );
  if (filter.property.type === "text") {
    return (
      <>
        {filter.operator === "!:" ? (
          <span className={styles.operator}>not</span>
        ) : null}
        {value}
      </>
    );
  }
  return (
    <>
      <span className={styles.property}>{propertyText(filter.property)}</span>
      <span className={styles.operator}>{filter.operator}</span>
      {value}
    </>
  );
}

/**
 * The edit panel under a token (spec M19), built as `FilterPopover`'s panel is. Enter in
 * the value applies; Escape or a pointer down outside the token cancels.
 */
function FilterEdit(props: {
  filter: ObjectFilter;
  /** The token's place, which marks the part of the page a pointer down keeps it open in. */
  anchor: number;
  context: FilterContext;
  /** The edited token, null when the edit removes it, or "cancel". */
  onDone(result: ObjectFilter | null | "cancel"): void;
}): ReactElement {
  const { filter } = props;
  const [operator, setOperator] = useState(filter.operator);
  const [value, setValue] = useState(filter.value);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const valueId = useId();
  const done = useRef(props.onDone);
  done.current = props.onDone;

  useEffect(() => {
    document.getElementById(valueId)?.focus();
  }, [valueId]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const inside =
        e.target instanceof Element &&
        e.target.closest(`[data-filter-token="${props.anchor}"]`) !== null;
      if (!inside) done.current("cancel");
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [props.anchor]);

  // The column's operators, and the token's own even when its column left the list,
  // so the choice it has stays on screen (column filter spec §3.5).
  const allowed = operatorsOf(filter.property, props.context);
  const choices = allowed.includes(filter.operator)
    ? allowed
    : [...allowed, filter.operator];

  const apply = () => {
    const result = editedFilter(filter, operator, value, props.context);
    if (result === "invalid")
      setError(measureHint(filter.property, props.context));
    else props.onDone(result);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // The drawer stays open: Escape here only cancels the edit.
      e.stopPropagation();
      props.onDone("cancel");
    } else if (
      e.key === "Enter" &&
      e.target instanceof HTMLElement &&
      e.target.id === valueId
    ) {
      e.preventDefault();
      apply();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Edit filter"
      className={styles.edit}
      data-testid="filter-edit"
      onKeyDown={onKeyDown}
    >
      <div className={styles.editRow}>
        <span className={styles.editLabel}>Property</span>
        <span className={styles.editProperty}>
          {propertyWords(filter.property, props.context)}
        </span>
      </div>
      <div className={styles.editRow}>
        <span className={styles.editLabel}>Operator</span>
        <Segmented
          label="Operator"
          size="sm"
          value={OPERATOR_IDS[operator]}
          options={choices.map((o) => ({
            value: OPERATOR_IDS[o],
            label: o,
            hint: operatorName(o, filter.property, props.context),
          }))}
          onChange={(id) => {
            setOperator(operatorOf(id));
            setError(null);
          }}
          testId="filter-edit-operator"
        />
      </div>
      <div className={styles.editRow}>
        <label htmlFor={valueId} className={styles.editLabel}>
          Value
        </label>
        <Input
          id={valueId}
          className={styles.editValue}
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          data-testid="filter-edit-value"
        />
        {error !== null ? (
          <p
            id={errorId}
            className={styles.editError}
            role="alert"
            data-testid="filter-edit-error"
          >
            {error}
          </p>
        ) : null}
      </div>
      <div className={styles.editFoot}>
        <Button
          size="sm"
          variant="secondary"
          data-testid="filter-edit-cancel"
          onClick={() => props.onDone("cancel")}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="filter-edit-apply"
          onClick={apply}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
