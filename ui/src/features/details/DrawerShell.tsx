import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../../design";
import { X } from "../../design/icons";
import { UnsavedEditsContext } from "../../kinds/detail/unsavedEdits";
import { DRAWER_PANE, usePaneSize } from "../../stores/paneSize";
import styles from "./DetailDrawer.module.css";
import { DrawerResize } from "./DrawerResize";

export interface DrawerShellProps {
  ref?: Ref<HTMLElement>;
  /** The drawer's accessible name. */
  label: string;
  testId: string;
  /** The small line above the title, such as the object's kind. */
  kind: ReactNode;
  kindTestId?: string;
  title: string;
  titleTestId?: string;
  dimTestId?: string;
  /** Before the kind, such as a Back button. */
  back?: ReactNode;
  /** After the kind, such as a status badge. */
  extra?: ReactNode;
  /** The drawer's actions; a divider follows them. */
  actions?: ReactNode;
  /** Between the actions and Close, such as Minimize. */
  tools?: ReactNode;
  closeTestId: string;
  onClose(): void;
  /**
   * Escape inside the drawer closes it. A resource screen closes its drawer from the
   * screen root instead (`isDrawerEscape`).
   */
  closeOnEscape?: boolean;
  children: ReactNode;
}

/**
 * Where a click on the dimmed screen is not one outside, as these parts work with the drawer
 * open:
 * - the drawer itself;
 * - a body row of a list's table, where a click shows that row in the drawer instead;
 * - the table's header, which sorts and resizes the columns;
 * - a part marked `data-keeps-drawer`, such as a list's toolbar and its row of filters.
 */
const KEEPS_OPEN =
  '[data-drawer], [data-keeps-drawer], [role="grid"] thead, [role="grid"] tbody tr';

/** What the dim covers: its containing block, the screen that owns the drawer. */
function dimmedScreen(dim: HTMLElement): HTMLElement | null {
  for (let el = dim.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).position !== "static") return el;
  }
  return null;
}

/**
 * Closes the drawer on a click of the primary button on the dimmed screen around it, as
 * Close does. The dim lets clicks through, so a row of the list behind still shows in the
 * drawer, and the list's toolbar and column headers still work; those clicks are not ones
 * outside (`KEEPS_OPEN`). The press and the release must both land
 * outside, so a resize drag or a text selection that ends there does not count. A portal
 * (a menu, a dialog, a tooltip) and the rest of the window (the sidebar, the dock) lie
 * outside the screen, and unsaved edits keep the drawer open.
 */
function useCloseOnClickOutside(
  dim: RefObject<HTMLDivElement | null>,
  unsaved: ReadonlySet<object>,
  onClose: () => void,
): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (e: PointerEvent): boolean => {
      const target = e.target;
      const screen = dim.current ? dimmedScreen(dim.current) : null;
      return (
        e.button === 0 &&
        target instanceof Element &&
        screen?.contains(target) === true &&
        target.closest(KEEPS_OPEN) === null
      );
    };
    let pressed = false;
    const onDown = (e: PointerEvent) => {
      pressed = outside(e);
    };
    const onUp = (e: PointerEvent) => {
      const clicked = pressed && outside(e);
      pressed = false;
      if (clicked && unsaved.size === 0) close.current();
    };
    const onCancel = () => {
      pressed = false;
    };
    // Captured, so the target is read before a handler can change what is under it.
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    };
  }, [dim, unsaved]);
}

/**
 * The frame every drawer shares (spec H12–H17): a dimmed screen under a floating panel
 * with a resize handle on its left border, a band with the kind, the actions and Close,
 * the title under them, then the drawer's own tabs and content. A click on the dimmed
 * screen closes it, unless a part inside holds unsaved edits (`useUnsavedEdits`).
 */
export function DrawerShell(props: DrawerShellProps) {
  const { onClose } = props;
  const [width, setWidth] = usePaneSize(DRAWER_PANE);
  const dim = useRef<HTMLDivElement>(null);
  const [unsaved] = useState(() => new Set<object>());
  useCloseOnClickOutside(dim, unsaved, onClose);
  const onKeyDown = props.closeOnEscape
    ? (e: KeyboardEvent<HTMLElement>) => {
        if (e.key !== "Escape") return;
        // A menu or tooltip in a portal still bubbles its keys here; that Escape is its own.
        if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target))
          return;
        e.stopPropagation();
        onClose();
      }
    : undefined;
  return (
    <>
      <div
        ref={dim}
        className={styles.dim}
        aria-hidden="true"
        data-testid={props.dimTestId ?? `${props.testId}-dim`}
      />
      <aside
        ref={props.ref}
        tabIndex={-1}
        className={styles.overlay}
        aria-label={props.label}
        data-testid={props.testId}
        data-drawer=""
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        <DrawerResize
          className={styles.handle}
          width={width}
          onChange={setWidth}
        />
        <div className={styles.frame}>
          <header className={styles.band}>
            <div className={styles.bandRow}>
              {props.back}
              <span className={styles.bandKind} data-testid={props.kindTestId}>
                {props.kind}
              </span>
              {props.extra}
              <div className={styles.grow} />
              {props.actions ? (
                <>
                  {props.actions}
                  <span className={styles.divider} aria-hidden="true" />
                </>
              ) : null}
              {props.tools}
              <IconButton
                label="Close details"
                icon={<X size={14} aria-hidden="true" />}
                onClick={onClose}
                data-testid={props.closeTestId}
              />
            </div>
            <h3
              className={styles.bandTitle}
              data-testid={props.titleTestId}
              title={props.title}
            >
              {props.title}
            </h3>
          </header>
          <UnsavedEditsContext.Provider value={unsaved}>
            {props.children}
          </UnsavedEditsContext.Provider>
        </div>
      </aside>
    </>
  );
}
