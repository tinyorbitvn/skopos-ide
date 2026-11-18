import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Box, Pen, Trash2, Zap } from "../../design/icons";
import { ObjectActionBar } from "./ObjectActionBar";
import type { ObjectActionItem } from "./objectActions";

const item = (
  id: string,
  over: Partial<ObjectActionItem> = {},
): ObjectActionItem => ({
  id,
  label: id,
  icon: Box,
  danger: false,
  disabled: false,
  top: false,
  run: () => {},
  ...over,
});

const remove = (over: Partial<ObjectActionItem> = {}) =>
  item("delete", { label: "Delete", icon: Trash2, danger: true, ...over });

test("a top item is an icon button named by its label", () => {
  const run = vi.fn();
  render(
    <ObjectActionBar
      items={[item("edit", { label: "Edit YAML", icon: Pen, top: true, run })]}
    />,
  );
  const group = screen.getByRole("group", { name: "Actions" });
  expect(group.getAttribute("data-testid")).toBe("detail-actions");
  const button = screen.getByRole("button", { name: "Edit YAML" });
  expect(button.getAttribute("data-testid")).toBe("detail-action-edit");
  expect(button.querySelector('[data-icon="pen"] svg')).not.toBeNull();
  fireEvent.click(button);
  expect(run).toHaveBeenCalledTimes(1);
});

test("More actions lists every item but Delete, top ones included, in order", () => {
  render(
    <ObjectActionBar
      items={[
        item("edit", { top: true }),
        item("scale"),
        item("force-delete", {
          label: "Force delete",
          icon: Zap,
          danger: true,
        }),
        remove(),
      ]}
    />,
  );
  const more = screen.getByTestId("detail-more-actions");
  expect(more.getAttribute("aria-label")).toBe("More actions");
  expect(more.getAttribute("title")).toBe("More actions");
  fireEvent.keyDown(more, { key: "Enter" });
  expect(
    screen.getAllByRole("menuitem").map((m) => m.getAttribute("data-testid")),
  ).toEqual(["menu-item-edit", "menu-item-scale", "menu-item-force-delete"]);
  expect(screen.queryByTestId("menu-item-delete")).toBeNull();
});

test("Delete is a trash icon button just before More actions, and runs Delete", () => {
  const run = vi.fn();
  render(
    <ObjectActionBar
      items={[item("edit", { top: true }), item("scale"), remove({ run })]}
    />,
  );
  const button = screen.getByRole("button", { name: "Delete" });
  expect(button.getAttribute("data-testid")).toBe("detail-action-delete");
  expect(button.querySelector('[data-icon="trash-2"] svg')).not.toBeNull();
  const buttons = screen
    .getByTestId("detail-actions")
    .querySelectorAll("button");
  expect(Array.from(buttons, (b) => b.getAttribute("data-testid"))).toEqual([
    "detail-action-edit",
    "detail-action-delete",
    "detail-more-actions",
  ]);
  fireEvent.click(button);
  expect(run).toHaveBeenCalledTimes(1);
});

test("Delete without the access to delete is a disabled button", () => {
  const run = vi.fn();
  render(<ObjectActionBar items={[remove({ disabled: true, run })]} />);
  const button = screen.getByTestId(
    "detail-action-delete",
  ) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(run).not.toHaveBeenCalled();
});

test("there is no More actions when every other item is a top item", () => {
  render(<ObjectActionBar items={[item("edit", { top: true }), remove()]} />);
  expect(screen.getByTestId("detail-action-delete")).toBeTruthy();
  expect(screen.queryByTestId("detail-more-actions")).toBeNull();
});

test("a disabled top item cannot be pressed", () => {
  const run = vi.fn();
  render(
    <ObjectActionBar
      items={[item("edit", { top: true, disabled: true, run })]}
    />,
  );
  const button = screen.getByTestId("detail-action-edit") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(run).not.toHaveBeenCalled();
});
