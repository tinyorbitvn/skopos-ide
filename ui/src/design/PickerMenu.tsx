import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check } from "./icons";
import styles from "./PickerMenu.module.css";

export interface PickerItem {
  id: string;
  label: string;
  /** More words the search matches, such as a template's kind and group. */
  keywords?: string[];
  icon?: ReactNode;
  hint?: string;
  /** A second line under the label. */
  description?: string;
  /** Marks the item in use with a check; `false` keeps the check's room. */
  checked?: boolean;
  disabled?: boolean;
  /** Why the item is disabled, shown in place of the hint. */
  disabledHint?: string;
  /** Replaces the default test id, `menu-item-‹id›`. */
  testId?: string;
  onSelect(): void;
}

export interface PickerSection {
  id: string;
  title?: string;
  items: PickerItem[];
}

/** The items whose label or keywords hold `query`, in order; sections left empty go. */
export function filterSections(
  sections: PickerSection[],
  query: string,
): PickerSection[] {
  const wanted = query.trim().toLowerCase();
  return sections
    .map((section) => ({
      ...section,
      items: wanted
        ? section.items.filter((item) =>
            [item.label, ...(item.keywords ?? [])].some((word) =>
              word.toLowerCase().includes(wanted),
            ),
          )
        : section.items,
    }))
    .filter((section) => section.items.length > 0);
}

/** Room kept between the list and the window's edge, in px. */
const MARGIN = 8;
const MIN_HEIGHT = 160;

/** A trigger that opens a searchable list of actions (YAML authoring spec D2, D5). */
export function PickerMenu(props: {
  /** The trigger. Its click must call `toggle`. */
  trigger(state: { open: boolean; toggle(): void }): ReactNode;
  /** The list's accessible name. */
  label: string;
  /** The search field's label and placeholder. */
  searchLabel: string;
  sections: PickerSection[];
  /** The line shown when nothing matches the trimmed query. */
  empty(query: string): string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  width?: number;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const anchor = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const side = props.side ?? "bottom";
  const shown = useMemo(
    () => filterSections(props.sections, query),
    [props.sections, query],
  );
  const enabled = shown
    .flatMap((section) => section.items)
    .filter((item) => !item.disabled);
  const current =
    enabled.find((item) => item.id === active) ?? enabled[0] ?? null;
  const optionId = (id: string) => `${listId}-${id}`;

  function close(refocus: boolean): void {
    setOpen(false);
    setQuery("");
    setActive(null);
    if (refocus) anchor.current?.querySelector<HTMLElement>("button")?.focus();
  }

  function pick(item: PickerItem): void {
    if (item.disabled) return;
    close(false);
    item.onSelect();
  }

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const box = anchor.current.getBoundingClientRect();
    const room = side === "top" ? box.top : window.innerHeight - box.bottom;
    setMaxHeight(Math.max(MIN_HEIGHT, room - MARGIN * 2));
    search.current?.focus();
  }, [open, side]);

  useEffect(() => {
    if (!open) return;
    function outside(event: Event): void {
      const target = event.target;
      if (!(target instanceof Node && anchor.current?.contains(target))) {
        setOpen(false);
        setQuery("");
        setActive(null);
      }
    }
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);

  function onKey(event: KeyboardEvent<HTMLInputElement>): void {
    const at = current ? enabled.indexOf(current) : -1;
    const moveTo = (index: number) => {
      event.preventDefault();
      const item = enabled[Math.min(Math.max(index, 0), enabled.length - 1)];
      if (!item) return;
      setActive(item.id);
      document
        .getElementById(optionId(item.id))
        ?.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "ArrowDown":
        moveTo(at + 1);
        break;
      case "ArrowUp":
        moveTo(at - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(enabled.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        if (current) pick(current);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
    }
  }

  return (
    <div ref={anchor} className={styles.anchor}>
      {props.trigger({
        open,
        toggle: () => (open ? close(false) : setOpen(true)),
      })}
      {open ? (
        <div
          role="dialog"
          aria-label={props.label}
          data-testid={props.testId}
          className={`${styles.panel} ${styles[side]} ${styles[props.align ?? "start"]}`}
          style={{ width: props.width ?? 280, maxHeight }}
        >
          <input
            ref={search}
            type="text"
            role="combobox"
            className={styles.search}
            aria-label={props.searchLabel}
            placeholder={props.searchLabel}
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? optionId(current.id) : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(null);
            }}
            onKeyDown={onKey}
            data-testid={`${props.testId}-search`}
          />
          {shown.length === 0 ? (
            <p
              className={styles.empty}
              role="status"
              data-testid={`${props.testId}-empty`}
            >
              {props.empty(query.trim())}
            </p>
          ) : (
            <div
              id={listId}
              role="listbox"
              aria-label={props.label}
              className={styles.list}
            >
              {shown.map((section) => (
                <fieldset
                  key={section.id}
                  aria-label={section.title}
                  className={styles.section}
                >
                  {section.title ? (
                    <div className={styles.heading} aria-hidden="true">
                      {section.title}
                    </div>
                  ) : null}
                  {section.items.map((item) => (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keys reach the options through the search field's aria-activedescendant.
                    <div
                      key={item.id}
                      id={optionId(item.id)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={item.id === current?.id}
                      aria-disabled={item.disabled ? true : undefined}
                      aria-current={item.checked ? "true" : undefined}
                      className={
                        item.description
                          ? `${styles.item} ${styles.described}`
                          : styles.item
                      }
                      data-testid={item.testId ?? `menu-item-${item.id}`}
                      onPointerMove={() => {
                        if (!item.disabled) setActive(item.id);
                      }}
                      onClick={() => pick(item)}
                    >
                      {item.checked === undefined ? null : (
                        <span className={styles.check} aria-hidden="true">
                          {item.checked ? <Check size={14} /> : null}
                        </span>
                      )}
                      {item.icon ? (
                        <span className={styles.icon}>{item.icon}</span>
                      ) : null}
                      {item.description ? (
                        <span className={styles.text}>
                          <span className={styles.label}>{item.label}</span>
                          <span className={styles.description}>
                            {item.description}
                          </span>
                        </span>
                      ) : (
                        <span className={styles.label}>{item.label}</span>
                      )}
                      {item.disabled && item.disabledHint ? (
                        <span className={styles.hint}>{item.disabledHint}</span>
                      ) : item.hint ? (
                        <span className={styles.hint}>{item.hint}</span>
                      ) : null}
                    </div>
                  ))}
                </fieldset>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
