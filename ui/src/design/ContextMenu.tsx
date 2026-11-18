import * as RC from "@radix-ui/react-context-menu";
import { Fragment, type ReactElement } from "react";
import styles from "./Menu.module.css";

export interface ContextMenuItem {
  id: string;
  label: string;
  onSelect(): void;
  /** Right-aligned text after the label: a key, or why the item is disabled. */
  hint?: string;
  disabled?: boolean;
  /** Replaces the default test id, `menu-item-‹id›`. */
  testId?: string;
  /** The item's tooltip, such as why it is disabled. */
  tooltip?: string;
  /** A line above the item starts a new group. */
  separated?: boolean;
}

export function ContextMenu(props: {
  children: ReactElement;
  items: ContextMenuItem[];
  /** The menu's accessible name. */
  label?: string;
}) {
  return (
    <RC.Root>
      <RC.Trigger asChild>{props.children}</RC.Trigger>
      <RC.Portal>
        <RC.Content className={styles.content} aria-label={props.label}>
          {props.items.map((it) => (
            <Fragment key={it.id}>
              {it.separated ? (
                <RC.Separator className={styles.separator} />
              ) : null}
              <RC.Item
                className={styles.item}
                disabled={it.disabled}
                onSelect={it.onSelect}
                title={it.tooltip}
                data-testid={it.testId ?? `menu-item-${it.id}`}
              >
                {it.label}
                {it.hint ? (
                  <span className={styles.hint}>{it.hint}</span>
                ) : null}
              </RC.Item>
            </Fragment>
          ))}
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  );
}
