import * as RT from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import styles from "./Tooltip.module.css";

/**
 * A hint on hover or focus. `label` is a short tip on the inverse surface. `card` is a
 * larger panel on the raised surface that follows the light and dark themes; give it a
 * `label`, which screen readers announce in place of the card's content. An Escape that
 * closes a card goes no further, so a drawer around the card stays open.
 */
export function Tooltip({
  content,
  children,
  variant = "label",
  label,
  side,
}: {
  content: ReactNode;
  children: ReactElement;
  variant?: "label" | "card";
  label?: string;
  /** Where it opens; Radix's default, top, when left out. */
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <RT.Provider delayDuration={400}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content
            className={
              variant === "card"
                ? `${styles.content} ${styles.card}`
                : styles.content
            }
            side={side}
            sideOffset={6}
            collisionPadding={variant === "card" ? 8 : 0}
            onEscapeKeyDown={
              variant === "card" ? (e) => e.stopPropagation() : undefined
            }
            {...(label === undefined ? {} : { "aria-label": label })}
          >
            {content}
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
