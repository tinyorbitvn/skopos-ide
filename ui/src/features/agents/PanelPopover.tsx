import { type ReactNode, useEffect, useRef } from "react";
import { IconButton } from "../../design";
import { X } from "../../design/icons";
import styles from "./PanelPopover.module.css";

/**
 * A popover under the panel's header (board): a scrim over the panel, a box with a title
 * and Close. Escape closes it and stops there, so the panel and the drawer stay open.
 */
export function PanelPopover(props: {
  label: string;
  testId: string;
  onClose(): void;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = body.current?.querySelector<HTMLElement>(
      "input:not(:disabled), button:not(:disabled)",
    );
    (first ?? box.current)?.focus();
  }, []);
  return (
    <>
      <div
        className={styles.scrim}
        aria-hidden="true"
        onPointerDown={props.onClose}
        data-testid={`${props.testId}-scrim`}
      />
      <div
        ref={box}
        role="dialog"
        aria-label={props.label}
        tabIndex={-1}
        className={styles.popover}
        data-testid={props.testId}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          props.onClose();
        }}
      >
        <div className={styles.head}>
          <span className={styles.title}>{props.label}</span>
          <IconButton
            label="Close"
            icon={<X size={14} aria-hidden="true" />}
            onClick={props.onClose}
            data-testid={`${props.testId}-close`}
          />
        </div>
        <div ref={body} className={styles.body}>
          {props.children}
        </div>
      </div>
    </>
  );
}
