import { Search } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { type FilterIndex, type ObjectFilter, parseFilter } from "./filter";
import {
  type SuggestionOption,
  suggestionOptions,
  suggestionsFor,
} from "./filterSuggestions";
import styles from "./PropertyFilter.module.css";

/** The box's label, and its placeholder while there is no token (spec M14). */
export const FILTER_LABEL = "Filter by name, namespace, label or annotation";

export interface PropertyFilterProps {
  text: string;
  onTextChange(text: string): void;
  tokens: readonly ObjectFilter[];
  onTokensChange(tokens: ObjectFilter[]): void;
  /** Keys, values and counts of the list's objects (spec M17). */
  index: FilterIndex;
  /** The text input, so the tokens row can hand focus back to it. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The list's filter box (spec M14–M16): a combobox whose suggestions build a filter from a
 * property, an operator and a value. Picking an option, with the keys or the pointer,
 * keeps focus in the box. Escape closes the suggestions, then clears the text; the
 * screen's `isDrawerEscape` keeps it from the drawer.
 */
export function PropertyFilter(props: PropertyFilterProps): ReactElement {
  const { text, tokens, index } = props;
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = props.inputRef ?? ownRef;
  const listId = useId();
  const footId = useId();
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(() => suggestionsFor(text, index), [text, index]);
  const options = useMemo(() => suggestionOptions(suggestions), [suggestions]);
  const position = useMemo(
    () => new Map(options.map((option, at) => [option, at])),
    [options],
  );
  // The first option is active whenever the options change (spec M16): a change of
  // content, so the keys identify the list; a rebuilt index with the same options keeps it.
  const optionKeys = useMemo(
    () => options.map((option) => option.key).join("\n"),
    [options],
  );
  const [moved, setMoved] = useState<{ keys: string; at: number } | null>(null);
  const active = moved !== null && moved.keys === optionKeys ? moved.at : 0;
  const optionId = (at: number) => `${listId}-option-${at}`;
  const activeId = open && options.length > 0 ? optionId(active) : undefined;

  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const addToken = (filter: ObjectFilter) => {
    props.onTokensChange([...tokens, filter]);
    props.onTextChange("");
    setOpen(true);
    inputRef.current?.focus();
  };

  const pick = (option: SuggestionOption) => {
    if (option.pick.type === "add") {
      addToken(option.pick.filter);
    } else {
      props.onTextChange(option.pick.text);
      setOpen(true);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        if (options.length === 0) return;
        const step = e.key === "ArrowDown" ? 1 : options.length - 1;
        setMoved({ keys: optionKeys, at: (active + step) % options.length });
        return;
      }
      case "Enter": {
        e.preventDefault();
        const option = open ? options[active] : undefined;
        if (option) {
          pick(option);
          return;
        }
        const parsed = parseFilter(text);
        if (parsed !== null && parsed !== "incomplete") addToken(parsed);
        return;
      }
      case "Escape":
        if (open) setOpen(false);
        else props.onTextChange("");
        return;
      case "Backspace":
        if (text === "" && tokens.length > 0) {
          props.onTokensChange(tokens.slice(0, -1));
        }
        return;
      case "Tab":
        setOpen(false);
        return;
    }
  };

  const optionButton = (option: SuggestionOption) => {
    const mine = position.get(option) ?? 0;
    return (
      <button
        key={option.key}
        type="button"
        role="option"
        tabIndex={-1}
        id={optionId(mine)}
        aria-selected={mine === active}
        className={styles.option}
        data-testid="filter-option"
        // A pick acts on pointerdown; holding the mouse down keeps focus in the box.
        onPointerDown={(e) => {
          e.preventDefault();
          pick(option);
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <span
          className={
            option.mono ? `${styles.main} ${styles.mono}` : styles.main
          }
        >
          {option.text}
        </span>
        <span className={styles.hint}>{option.hint}</span>
      </button>
    );
  };

  return (
    <div className={styles.filter}>
      <div className={styles.box}>
        <Search size={14} aria-hidden="true" className={styles.icon} />
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-describedby={open ? footId : undefined}
          aria-label={FILTER_LABEL}
          placeholder={tokens.length > 0 ? "Add a filter" : FILTER_LABEL}
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={(e) => {
            props.onTextChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          data-testid="resource-search"
        />
      </div>
      {open ? (
        <div className={styles.panel}>
          <div
            id={listId}
            role="listbox"
            aria-label="Filter suggestions"
            className={styles.list}
            data-testid="filter-suggestions"
          >
            {suggestions.lead.map(optionButton)}
            {suggestions.groups.map((group, g) => (
              // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a group of suggestions does not want.
              <div
                key={group.heading}
                role="group"
                aria-labelledby={`${listId}-group-${g}`}
              >
                <div id={`${listId}-group-${g}`} className={styles.heading}>
                  {group.heading}
                </div>
                {group.options.map(optionButton)}
              </div>
            ))}
          </div>
          <p id={footId} className={styles.foot} data-testid="filter-foot">
            {suggestions.foot}
          </p>
        </div>
      ) : null}
    </div>
  );
}
