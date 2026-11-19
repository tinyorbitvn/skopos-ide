import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DrawerShell } from "./DrawerShell";

function show(over: Partial<Parameters<typeof DrawerShell>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <DrawerShell
      label="Thing details"
      testId="thing-drawer"
      kind="Thing in shop"
      title="web"
      closeTestId="thing-close"
      onClose={onClose}
      actions={<button type="button">Act</button>}
      {...over}
    >
      <p>Body</p>
    </DrawerShell>,
  );
  return { onClose };
}

test("draws the shared frame: dim, resize handle, kind band, title, then the body", () => {
  show({ extra: <span data-testid="thing-status">Running</span> });
  const drawer = screen.getByRole("complementary", { name: "Thing details" });
  expect(drawer.hasAttribute("data-drawer")).toBe(true);
  expect(screen.getByTestId("thing-drawer-dim")).toBeTruthy();
  expect(within(drawer).getByTestId("drawer-resize")).toBeTruthy();
  const band = drawer.querySelector("header") as HTMLElement;
  expect(within(band).getByText("Thing in shop")).toBeTruthy();
  expect(within(band).getByTestId("thing-status")).toBeTruthy();
  expect(within(band).getByRole("heading", { name: "web" })).toBeTruthy();
  expect(within(band).getByRole("button", { name: "Act" })).toBeTruthy();
  expect(within(band).getByRole("button", { name: "Close details" })).toBe(
    screen.getByTestId("thing-close"),
  );
  expect(within(drawer).getByText("Body")).toBeTruthy();
  expect(band.querySelector(".divider")).not.toBeNull();
});

test("Escape inside closes it only when asked to", () => {
  const first = show();
  fireEvent.keyDown(screen.getByRole("heading", { name: "web" }), {
    key: "Escape",
  });
  expect(first.onClose).not.toHaveBeenCalled();
  cleanup();

  const second = show({ closeOnEscape: true });
  fireEvent.keyDown(screen.getByRole("heading", { name: "web" }), {
    key: "Escape",
  });
  expect(second.onClose).toHaveBeenCalledTimes(1);
});

test("a drawer without actions draws no divider before Close", () => {
  show({ actions: null });
  const band = screen.getByTestId("thing-drawer").querySelector("header");
  expect(band?.querySelector(".divider")).toBeNull();
});
