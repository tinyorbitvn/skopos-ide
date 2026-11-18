import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Pen, Trash2 } from "./icons";
import type { IconAnimation } from "./iconTrigger";
import { Menu } from "./Menu";

// The animated trash can, replaced by one that records what its control asks of it.
const motion = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("@animateicons/react/lucide/trash-2-icon", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Trash2Icon: forwardRef<
      IconAnimation,
      { size?: number; className?: string }
    >(function Trash2Icon({ size, className }, ref) {
      useImperativeHandle(ref, () => ({
        startAnimation: motion.start,
        stopAnimation: motion.stop,
      }));
      return (
        <div className={className}>
          <svg width={size} height={size} aria-hidden="true" />
        </div>
      );
    }),
  };
});

const matchMedia = window.matchMedia;

beforeEach(() => {
  motion.start.mockClear();
  motion.stop.mockClear();
});

afterEach(() => {
  window.matchMedia = matchMedia;
});

/** Focus as the Tab key moves it, which is keyboard focus, not the focus a click brings. */
function tabTo(element: HTMLElement): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
  act(() => element.focus());
}

function reduceMotion(): void {
  window.matchMedia = (media: string) =>
    ({
      matches: media === "(prefers-reduced-motion: reduce)",
      media,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
}

test("hovering a button plays its icon, and leaving puts it back", () => {
  render(
    <Button>
      <Trash2 size={16} aria-hidden="true" />
      Delete
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Delete" });
  fireEvent.mouseEnter(button);
  expect(motion.start).toHaveBeenCalledTimes(1);
  expect(motion.stop).not.toHaveBeenCalled();
  fireEvent.mouseLeave(button);
  expect(motion.stop).toHaveBeenCalledTimes(1);
  fireEvent.mouseEnter(button);
  expect(motion.start).toHaveBeenCalledTimes(2);
});

test("keyboard focus on an icon button plays its icon, and moving on puts it back", () => {
  render(
    <>
      <IconButton
        label="Delete"
        icon={<Trash2 size={16} aria-hidden="true" />}
      />
      <button type="button">Next</button>
    </>,
  );
  tabTo(screen.getByRole("button", { name: "Delete" }));
  expect(motion.start).toHaveBeenCalledTimes(1);
  tabTo(screen.getByRole("button", { name: "Next" }));
  expect(motion.stop).toHaveBeenCalledTimes(1);
});

test("hover and focus together play it once, and it stops when both have left", () => {
  render(
    <Button>
      <Trash2 size={16} aria-hidden="true" />
      Delete
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Delete" });
  fireEvent.mouseEnter(button);
  tabTo(button);
  expect(motion.start).toHaveBeenCalledTimes(1);
  fireEvent.mouseLeave(button);
  expect(motion.stop).not.toHaveBeenCalled();
  act(() => button.blur());
  expect(motion.stop).toHaveBeenCalledTimes(1);
});

test("a menu item plays its icon when the keyboard moves to it", () => {
  render(
    <Menu
      trigger={<button type="button">More</button>}
      items={[
        { id: "edit", label: "Edit YAML", icon: <Pen size={16} /> },
        { id: "delete", label: "Delete", icon: <Trash2 size={16} /> },
      ]}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), {
    key: "Enter",
  });
  const [edit, remove] = screen.getAllByRole("menuitem");
  expect(document.activeElement).toBe(edit);
  expect(motion.start).not.toHaveBeenCalled();
  // ArrowDown moves the menu's focus to the next item; under jsdom the test moves it.
  fireEvent.keyDown(edit, { key: "ArrowDown" });
  act(() => remove.focus());
  expect(motion.start).toHaveBeenCalledTimes(1);
});

test("a menu item plays its icon when hovered", () => {
  render(
    <Menu
      trigger={<button type="button">More</button>}
      items={[
        { id: "edit", label: "Edit YAML", icon: <Pen size={16} /> },
        { id: "delete", label: "Delete", icon: <Trash2 size={16} /> },
      ]}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), {
    key: "Enter",
  });
  fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Delete" }));
  expect(motion.start).toHaveBeenCalledTimes(1);
});

test("an icon outside any control stays still", () => {
  render(
    <p data-testid="text">
      <Trash2 size={16} aria-hidden="true" />
      Deleted
    </p>,
  );
  const text = screen.getByTestId("text");
  fireEvent.mouseEnter(text);
  fireEvent.mouseEnter(text.firstElementChild as HTMLElement);
  expect(motion.start).not.toHaveBeenCalled();
});

test("a disabled control keeps its icon still", () => {
  render(
    <Button disabled>
      <Trash2 size={16} aria-hidden="true" />
      Delete
    </Button>,
  );
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Delete" }));
  expect(motion.start).not.toHaveBeenCalled();
});

test("with reduced motion the icon never plays", () => {
  reduceMotion();
  render(
    <Button>
      <Trash2 size={16} aria-hidden="true" />
      Delete
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Delete" });
  fireEvent.mouseEnter(button);
  tabTo(button);
  expect(motion.start).not.toHaveBeenCalled();
  fireEvent.mouseLeave(button);
  act(() => button.blur());
  expect(motion.stop).not.toHaveBeenCalled();
});

test("the focus a click brings does not play it", () => {
  render(
    <Button>
      <Trash2 size={16} aria-hidden="true" />
      Delete
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Delete" });
  fireEvent.mouseDown(button);
  act(() => button.focus());
  expect(motion.start).not.toHaveBeenCalled();
});

test("reduced motion is read when the control is hovered, so turning it on applies at once", () => {
  render(
    <Button>
      <Trash2 size={16} aria-hidden="true" />
      Delete
    </Button>,
  );
  reduceMotion();
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Delete" }));
  expect(motion.start).not.toHaveBeenCalled();
});
