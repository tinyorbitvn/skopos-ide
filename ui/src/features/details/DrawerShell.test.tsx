import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { expect, test, vi } from "vitest";
import { useUnsavedEdits } from "../../kinds/detail/unsavedEdits";
import { DrawerShell, type DrawerShellProps } from "./DrawerShell";

/** The drawer over its screen, beside a sidebar outside it, as the app lays them out. */
function layout(
  over: Partial<DrawerShellProps>,
  onClose: () => void,
): React.JSX.Element {
  return (
    <>
      <nav data-testid="sidebar">
        <button type="button">Pods</button>
      </nav>
      <div data-testid="screen" style={{ position: "relative" }}>
        <h2 data-testid="screen-title">Things</h2>
        <div data-keeps-drawer="">
          <button type="button">Filter</button>
        </div>
        <table
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the list's table, as VirtualTable draws it.
          role="grid"
        >
          <thead>
            <tr>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>db</td>
            </tr>
          </tbody>
        </table>
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
          {over.children ?? <p>Body</p>}
        </DrawerShell>
      </div>
    </>
  );
}

function show(over: Partial<DrawerShellProps> = {}) {
  const onClose = vi.fn();
  const view = render(layout(over, onClose));
  return {
    onClose,
    rerender: (next: Partial<DrawerShellProps>) =>
      view.rerender(layout(next, onClose)),
  };
}

/** A press and release of one mouse button on `el`, and the click a primary one makes. */
function click(el: Element, button = 0) {
  fireEvent.pointerDown(el, { button });
  fireEvent.pointerUp(el, { button });
  if (button === 0) fireEvent.click(el);
}

const dimmed = () => screen.getByTestId("screen-title");

function Editing(props: { unsaved: boolean }) {
  useUnsavedEdits(props.unsaved);
  return <p>Editing</p>;
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

test("a click on the dimmed screen around the drawer closes it, as Close does", () => {
  const { onClose } = show();
  click(dimmed());
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a click inside the drawer or outside its screen, as on the sidebar, leaves it open", () => {
  const { onClose } = show();
  click(screen.getByText("Body"));
  click(screen.getByRole("button", { name: "Act" }));
  click(screen.getByRole("button", { name: "Pods" }));
  expect(onClose).not.toHaveBeenCalled();
});

test("a click on a row, the table's header or the toolbar leaves it open, as they work with it", () => {
  const { onClose } = show();
  click(screen.getByRole("cell", { name: "db" }));
  click(screen.getByRole("columnheader", { name: "Name" }));
  click(screen.getByRole("button", { name: "Filter" }));
  expect(onClose).not.toHaveBeenCalled();
});

test("a click in a portal, such as a menu the drawer opened, leaves it open", () => {
  const { onClose } = show({
    children: createPortal(
      <div role="menu">
        <button type="button" role="menuitem">
          Restart
        </button>
      </div>,
      document.body,
    ),
  });
  click(screen.getByRole("menuitem", { name: "Restart" }));
  expect(onClose).not.toHaveBeenCalled();
});

test("a press and a release must both land outside: a drag that crosses the edge is no click", () => {
  const { onClose } = show();
  // A resize drag, then a text selection, that end over the dim.
  for (const start of [
    screen.getByTestId("drawer-resize"),
    screen.getByText("Body"),
  ]) {
    fireEvent.pointerDown(start, { button: 0 });
    fireEvent.pointerUp(dimmed(), { button: 0 });
    // The click goes to what both share: the screen.
    fireEvent.click(screen.getByTestId("screen"));
  }
  // A press on the dim released inside the drawer.
  fireEvent.pointerDown(dimmed(), { button: 0 });
  fireEvent.pointerUp(screen.getByText("Body"), { button: 0 });
  expect(onClose).not.toHaveBeenCalled();
  click(dimmed());
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a right or middle click on the dim leaves it open", () => {
  const { onClose } = show();
  click(dimmed(), 2);
  fireEvent.contextMenu(dimmed());
  click(dimmed(), 1);
  expect(onClose).not.toHaveBeenCalled();
});

test("unsaved edits in the drawer keep it open until they are saved or dropped", () => {
  const { onClose, rerender } = show({ children: <Editing unsaved /> });
  click(dimmed());
  expect(onClose).not.toHaveBeenCalled();
  rerender({ children: <Editing unsaved={false} /> });
  click(dimmed());
  expect(onClose).toHaveBeenCalledTimes(1);
});
