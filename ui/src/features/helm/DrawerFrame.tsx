import { type ReactNode, useEffect, useRef } from "react";
import { DrawerShell } from "../details/DrawerShell";
import bar from "../resources/ObjectActionBar.module.css";

/**
 * A Helm drawer in the frame every drawer shares: focus comes in on open and goes back on
 * close, and Escape inside the drawer or a click on the dim around it closes it.
 */
export function DrawerFrame(props: {
  label: string;
  testId: string;
  title: string;
  kind: string;
  /** After the kind line, such as a status badge. */
  extra?: ReactNode;
  /** Icon buttons before the divider and the Close button. */
  actions?: ReactNode;
  onClose(): void;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  return (
    <DrawerShell
      ref={drawerRef}
      label={props.label}
      testId={props.testId}
      kind={props.kind}
      title={props.title}
      extra={props.extra}
      closeTestId={`${props.testId}-close`}
      onClose={props.onClose}
      closeOnEscape
      actions={
        props.actions ? (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a header toolbar does not want.
          <div role="group" aria-label="Actions" className={bar.bar}>
            {props.actions}
          </div>
        ) : null
      }
    >
      {props.children}
    </DrawerShell>
  );
}
