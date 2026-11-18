import * as RC from "@radix-ui/react-context-menu";
import { Fragment, type ReactElement } from "react";
import { ChevronRight } from "./icons";
import styles from "./Menu.module.css";

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Right-aligned text after the label: a key, or why the item is disabled. */
  hint?: string;
  disabled?: boolean;
  /** Replaces the default test id, `menu-item-‹id›`. */
  testId?: string;
  /** The item's tooltip, such as why it is disabled. */
  tooltip?: string;
  /** A line above the item starts a new group. */
  separated?: boolean;
  /** Items of a submenu that opens beside this one, instead of an action. */
  sub?: ContextMenuItem[];
  onSelect?(): void;
}

function ContextMenuItems(props: { items: ContextMenuItem[] }) {
  return props.items.map((it) => (
    <Fragment key={it.id}>
      {it.separated ? <RC.Separator className={styles.separator} /> : null}
      {it.sub ? (
        <RC.Sub>
          <RC.SubTrigger
            className={styles.item}
            disabled={it.disabled}
            title={it.tooltip}
            data-testid={it.testId ?? `menu-item-${it.id}`}
          >
            {it.label}
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={styles.more}
            />
          </RC.SubTrigger>
          <RC.Portal>
            <RC.SubContent
              className={`${styles.content} ${styles.scrolling}`}
              sideOffset={4}
            >
              <ContextMenuItems items={it.sub} />
            </RC.SubContent>
          </RC.Portal>
        </RC.Sub>
      ) : (
        <RC.Item
          className={styles.item}
          disabled={it.disabled}
          onSelect={it.onSelect}
          title={it.tooltip}
          data-testid={it.testId ?? `menu-item-${it.id}`}
        >
          {it.label}
          {it.hint ? <span className={styles.hint}>{it.hint}</span> : null}
        </RC.Item>
      )}
    </Fragment>
  ));
}

export function ContextMenu(props: {
  children: ReactElement;
  items: ContextMenuItem[];
  /** The menu's accessible name. */
  label?: string;
  /** Called when the menu opens or closes, such as to read what it lists. */
  onOpenChange?(open: boolean): void;
}) {
  return (
    <RC.Root onOpenChange={props.onOpenChange}>
      <RC.Trigger asChild>{props.children}</RC.Trigger>
      <RC.Portal>
        <RC.Content className={styles.content} aria-label={props.label}>
          <ContextMenuItems items={props.items} />
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  );
}
