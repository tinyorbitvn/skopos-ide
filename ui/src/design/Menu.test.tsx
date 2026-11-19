import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
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
