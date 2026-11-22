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
  type FilterJoin,
  type FilterOperator,
  filterText,
  type ObjectFilter,
  OPERATORS,
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
  ">": "greater-than",
  "<": "less-than",
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
 * The token an edit gives, or null when the edit removes it: an empty value removes it,
 * except for a label or annotation with `:` or `!:`, where it means any value (spec M19).
 */
export function editedFilter(
  filter: ObjectFilter,
  operator: FilterOperator,
  value: string,
): ObjectFilter | null {
  const trimmed = value.trim();
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
      data-keeps-drawer=""
    >
      {tokens.map((token, i) => {
        const text = filterText(token);
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
  /** The edited token, null when the edit removes it, or "cancel". */
  onDone(result: ObjectFilter | null | "cancel"): void;
}): ReactElement {
  const { filter } = props;
  const [operator, setOperator] = useState(filter.operator);
  const [value, setValue] = useState(filter.value);
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

  const apply = () => props.onDone(editedFilter(filter, operator, value));

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
          {propertyWords(filter.property)}
        </span>
      </div>
      <div className={styles.editRow}>
        <span className={styles.editLabel}>Operator</span>
        <Segmented
          label="Operator"
          size="sm"
          value={OPERATOR_IDS[operator]}
          options={operatorsOf(filter.property).map((o) => ({
            value: OPERATOR_IDS[o],
            label: o,
            hint: OPERATORS.find((x) => x.operator === o)?.name,
          }))}
          onChange={(id) => setOperator(operatorOf(id))}
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
          onChange={(e) => setValue(e.target.value)}
          data-testid="filter-edit-value"
        />
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
