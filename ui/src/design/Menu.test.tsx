import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CSS_FILES, cssRules } from "../test/css";
import { Menu } from "./Menu";

function open(): HTMLElement {
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), {
    key: "Enter",
  });
  return screen.getByRole("menu");
}

test("a menu opens on the side and alignment it is given, with its own class", () => {
  render(
    <Menu
      trigger={<button type="button">More</button>}
      side="top"
      align="start"
      sideOffset={6}
      avoidCollisions={false}
      className="extra"
      items={[{ id: "a", label: "A", onSelect: vi.fn() }]}
    />,
  );
  const menu = open();
  expect([
    menu.getAttribute("data-side"),
    menu.getAttribute("data-align"),
    menu.classList.contains("content"),
    menu.classList.contains("extra"),
  ]).toEqual(["top", "start", true, true]);
});

test("by default a menu opens below, aligned to its trigger's end", () => {
  render(
    <Menu
      trigger={<button type="button">More</button>}
      items={[{ id: "a", label: "A" }]}
    />,
  );
  const menu = open();
  expect([
    menu.getAttribute("data-side"),
    menu.getAttribute("data-align"),
    menu.className,
  ]).toEqual(["bottom", "end", "content"]);
});

test("menus have the design's metrics, a focus ring and a divider between groups (spec Q §5)", () => {
  const rules = cssRules(CSS_FILES["/src/design/Menu.module.css"]);
  const decl = (selector: string, prop: string) =>
    rules
      .find((r) => r.selector === selector)
      ?.decls.find(([p]) => p === prop)?.[1];
  expect([
    decl(".content", "min-width"),
    decl(".content", "padding"),
    decl(".content", "border-radius"),
    decl(".content", "box-shadow"),
    decl(".item", "height"),
    decl(".item", "padding"),
    decl(".item[data-highlighted]", "background"),
    decl(".item:focus-visible", "outline"),
    decl(".item:focus-visible", "box-shadow"),
    decl(".separator", "margin"),
    decl(".separator", "background"),
  ]).toEqual([
    "260px",
    "var(--space-3)",
    "var(--radius-md)",
    "var(--shadow-3)",
    "var(--control-sm)",
    "0 var(--space-6)",
    "var(--surface-hover)",
    "none",
    "var(--focus-ring)",
    "var(--space-3) var(--space-4)",
    "var(--divider)",
  ]);
});
