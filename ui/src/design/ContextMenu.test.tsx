import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

test("a context menu item can open a submenu, and the menu says when it opens", async () => {
  const opened = vi.fn();
  const picked = vi.fn();
  render(
    <ContextMenu
      label="Actions"
      onOpenChange={opened}
      items={[
        { id: "pin", label: "Pin tab", onSelect: () => {} },
        {
          id: "window",
          label: "Move to window",
          testId: "own-window",
          sub: [
            {
              id: "window-main",
              label: "Main window",
              hint: "Pods · prod",
              onSelect: picked,
            },
            {
              id: "window-new",
              label: "New window",
              disabled: true,
              tooltip: "Not now",
            },
          ],
        },
      ]}
    >
      <button type="button">Tab</button>
    </ContextMenu>,
  );

  fireEvent.contextMenu(screen.getByRole("button", { name: "Tab" }));
  expect(opened).toHaveBeenCalledWith(true);
  const trigger = await screen.findByTestId("own-window");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  fireEvent.keyDown(trigger, { key: "ArrowRight" });

  const main = await screen.findByTestId("menu-item-window-main");
  expect(main.textContent).toBe("Main windowPods · prod");
  const disabled = screen.getByTestId("menu-item-window-new");
  expect(disabled.hasAttribute("data-disabled")).toBe(true);
  expect(disabled.getAttribute("title")).toBe("Not now");
  fireEvent.click(main);
  expect(picked).toHaveBeenCalled();
});
