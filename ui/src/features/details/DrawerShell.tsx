import type { KeyboardEvent, ReactNode, Ref } from "react";
import { IconButton } from "../../design";
import { X } from "../../design/icons";
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
 * The frame every drawer shares (spec H12–H17): a dimmed screen under a floating panel
 * with a resize handle on its left border, a band with the kind, the actions and Close,
 * the title under them, then the drawer's own tabs and content.
 */
export function DrawerShell(props: DrawerShellProps) {
  const { onClose } = props;
  const [width, setWidth] = usePaneSize(DRAWER_PANE);
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
          {props.children}
        </div>
      </aside>
    </>
  );
}
