import * as RM from "@radix-ui/react-dropdown-menu";
import { Fragment, type ReactNode } from "react";
import { Check, ChevronRight } from "./icons";
import styles from "./Menu.module.css";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Replaces the default test id, `menu-item-‹id›`. */
  testId?: string;
  /** Right-aligned text after the label: a key, or why the item is disabled. */
  hint?: string;
  /** The item's tooltip, such as why it is disabled. */
  tooltip?: string;
  /** A line above the item starts a new group. */
  separated?: boolean;
  /** Items of a submenu that opens beside this one, instead of an action. */
  sub?: MenuItem[];
  onSelect?(): void;
}

function MenuItems(props: { items: MenuItem[] }) {
  return props.items.map((it) => (
    <Fragment key={it.id}>
      {it.separated ? <RM.Separator className={styles.separator} /> : null}
      {it.sub ? (
        <RM.Sub>
          <RM.SubTrigger
            className={styles.item}
            disabled={it.disabled}
            title={it.tooltip}
            data-testid={it.testId ?? `menu-item-${it.id}`}
          >
            {it.icon ? <span className={styles.icon}>{it.icon}</span> : null}
            {it.label}
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={styles.more}
            />
          </RM.SubTrigger>
          <RM.Portal>
            <RM.SubContent
              className={`${styles.content} ${styles.scrolling}`}
              sideOffset={4}
            >
              <MenuItems items={it.sub} />
            </RM.SubContent>
          </RM.Portal>
        </RM.Sub>
      ) : (
        <RM.Item
          className={`${styles.item} ${it.danger ? styles.danger : ""}`}
          disabled={it.disabled}
          onSelect={it.onSelect}
          title={it.tooltip}
          data-testid={it.testId ?? `menu-item-${it.id}`}
        >
          {it.icon ? <span className={styles.icon}>{it.icon}</span> : null}
          {it.label}
          {it.hint ? <span className={styles.hint}>{it.hint}</span> : null}
        </RM.Item>
      )}
    </Fragment>
  ));
}

export function Menu(props: { trigger: ReactNode; items: MenuItem[] }) {
  return (
    <RM.Root>
      <RM.Trigger asChild>{props.trigger}</RM.Trigger>
      <RM.Portal>
        <RM.Content className={styles.content} align="end" sideOffset={4}>
          <MenuItems items={props.items} />
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

/** A menu of checkboxes, which stays open so several can be changed in one go. */
export function CheckMenu(props: {
  trigger: ReactNode;
  items: {
    id: string;
    label: string;
    checked: boolean;
    testId?: string;
    onToggle(): void;
  }[];
}) {
  return (
    <RM.Root>
      <RM.Trigger asChild>{props.trigger}</RM.Trigger>
      <RM.Portal>
        <RM.Content
          className={`${styles.content} ${styles.scrolling}`}
          align="start"
          sideOffset={4}
        >
          {props.items.map((it) => (
            <RM.CheckboxItem
              key={it.id}
              className={styles.item}
              checked={it.checked}
              onCheckedChange={it.onToggle}
              onSelect={(e) => e.preventDefault()}
              data-testid={it.testId}
            >
              <span className={styles.check}>
                <RM.ItemIndicator>
                  <Check size={14} aria-hidden="true" />
                </RM.ItemIndicator>
              </span>
              {it.label}
            </RM.CheckboxItem>
          ))}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}
