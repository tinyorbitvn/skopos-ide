/**
 * The window's panes and tabs (spec P6 to P22) as the page shows them, and the clicks,
 * keys and drags that change them.
 */
import { byTestId, clickWhenShown, gone, shown } from "./ui";

const TIMEOUT = 15000;

/**
 * Each pane's tabs, panes split by " | " and tabs by ",": a tab is its screen name, with
 * "*" before the selected tab of its pane and "^" after a pinned one; ">" marks the
 * focused pane when there is more than one.
 */
export async function paneShape(): Promise<string> {
  return browser.execute(() => {
    const panes = Array.from(document.querySelectorAll("section[data-pane-id]"));
    return panes
      .map((pane) => {
        const tabs = Array.from(pane.querySelectorAll('[role="presentation"][data-drop-index]')).map(
          (wrapper) => {
            const button = wrapper.querySelector('[role="tab"]');
            const screen = (button?.getAttribute("aria-label") ?? "").split(" · ")[0];
            const selected = wrapper.getAttribute("data-selected") === "true" ? "*" : "";
            const pinned = wrapper.getAttribute("data-pinned") === "true" ? "^" : "";
            return `${selected}${screen}${pinned}`;
          },
        );
        const focused = pane.getAttribute("data-focused") === "true" ? ">" : "";
        return `${focused}${tabs.join(",")}`;
      })
      .join(" | ");
  });
}

export async function expectShape(shape: string, timeout = TIMEOUT): Promise<void> {
  let last = "";
  await browser
    .waitUntil(
      async () => {
        last = await paneShape();
        return last === shape;
      },
      { timeout, interval: 200 },
    )
    .catch(() => {
      throw new Error(`the panes never showed "${shape}"; they show "${last}"`);
    });
}

/** The tab of pane `pane` (0-based) whose screen is `screen`. */
export function tabIn(pane: number, screen: string) {
  return browser.$(
    `//section[@data-testid="pane-${pane}"]//*[@role="tab"][@aria-label="${screen}" or starts-with(@aria-label, "${screen} · ")]`,
  );
}

/** The test id of that tab, `tab-‹id›`. */
export async function tabTestId(pane: number, screen: string): Promise<string> {
  const tab = tabIn(pane, screen);
  await tab.waitForExist({ timeout: TIMEOUT, timeoutMsg: `pane ${pane} has no ${screen} tab` });
  return (await tab.getAttribute("data-testid")) ?? "";
}

/** An element inside pane `pane`'s body. */
export function inPane(pane: number, id: string) {
  return browser.$(`[data-testid="pane-body-${pane}"] [data-testid="${id}"]`);
}

/** Waits for the resource screen of pane `pane` to show `kind`. */
export async function expectPaneTitle(pane: number, kind: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const title = inPane(pane, "resource-title");
      return (await title.isExisting()) && (await title.getText()) === kind;
    },
    { timeout: TIMEOUT, timeoutMsg: `pane ${pane} never showed ${kind}` },
  );
}

export interface Point {
  x: number;
  y: number;
}

/** The centre of an element on the page, in client pixels. */
export async function centre(element: WebdriverIO.Element): Promise<Point> {
  await element.waitForDisplayed({ timeout: TIMEOUT });
  const at = await element.getLocation();
  const size = await element.getSize();
  return { x: Math.round(at.x + size.width / 2), y: Math.round(at.y + size.height / 2) };
}

function mouse() {
  return browser.action("pointer", { parameters: { pointerType: "mouse" } });
}

/** A press and release of `button` on the element's centre, with the real pointer. */
async function press(element: WebdriverIO.Element, button: 0 | 1): Promise<void> {
  const { x, y } = await centre(element);
  await mouse().move({ x, y }).down({ button }).up({ button }).perform();
}

/** Sends a mouse event of `type` to the element's centre, as the page would get it. */
async function send(
  element: WebdriverIO.Element,
  type: "click" | "auxclick" | "dblclick",
  init: { button: number; detail: number; ctrlKey?: boolean },
): Promise<void> {
  await browser.execute(
    (el, t, i) => {
      const target = el as unknown as HTMLElement;
      const box = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent(t, {
          bubbles: true,
          cancelable: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          ...i,
        }),
      );
    },
    element,
    type,
    init,
  );
}

/**
 * Ctrl+click. The driver's pointer carries no modifier, even with Ctrl held down in a key
 * action of the same sequence, so the click goes in with `ctrlKey` set.
 */
export async function ctrlClick(element: WebdriverIO.Element): Promise<void> {
  await element.waitForDisplayed({ timeout: TIMEOUT });
  await send(element, "click", { button: 0, detail: 1, ctrlKey: true });
}

/**
 * A middle-click: the real press and release of the middle button, then the `auxclick`
 * the driver does not send.
 */
export async function middleClick(element: WebdriverIO.Element): Promise<void> {
  await press(element, 1);
  await send(element, "auxclick", { button: 1, detail: 1 });
}

/**
 * A double-click: two real clicks at one point, then the `dblclick` the driver does not
 * send (its clicks both count 1).
 */
export async function doubleClick(element: WebdriverIO.Element): Promise<void> {
  const { x, y } = await centre(element);
  await mouse()
    .move({ x, y })
    .down({ button: 0 })
    .up({ button: 0 })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
  await send(element, "dblclick", { button: 0, detail: 2 });
}

/** Presses on `element` and moves past the 6 px threshold that starts a drag (P22). */
function startDrag(from: Point) {
  return mouse()
    .move({ x: from.x, y: from.y })
    .down({ button: 0 })
    .pause(100)
    .move({ x: from.x + 12, y: from.y + 4, duration: 100 })
    .pause(100);
}

/**
 * Drags `element` to the point `to` and lets go there, in one action sequence: in a
 * later sequence the driver's moves report no pressed button (`buttons` 0), and the page
 * takes such a move for a release it missed and cancels the drag.
 */
export async function dragTo(element: WebdriverIO.Element, to: Point): Promise<void> {
  await startDrag(await centre(element))
    .move({ x: to.x, y: to.y, duration: 200 })
    .pause(200)
    .up({ button: 0 })
    .perform();
  // The click that ends a drag is swallowed until the next task.
  await browser.pause(100);
}

/** A point in the left or right half of pane `pane`'s body. */
export async function paneHalf(pane: number, side: "left" | "right"): Promise<Point> {
  const body = await shown(`pane-body-${pane}`);
  const at = await body.getLocation();
  const size = await body.getSize();
  return {
    x: Math.round(at.x + size.width * (side === "left" ? 0.25 : 0.75)),
    y: Math.round(at.y + size.height / 2),
  };
}

/** Opens a tab's menu as the keyboard does: Shift+F10 on the focused tab (P15). */
export async function openTabMenu(tab: WebdriverIO.Element): Promise<void> {
  await browser.execute((el) => (el as unknown as HTMLElement).focus(), tab);
  await browser.keys(["Shift", "F10"]);
  await shown("tab-menu-pin");
}

/** Picks `item` (`tab-menu-‹item›`) from a tab's menu. */
export async function tabMenu(tab: WebdriverIO.Element, item: string): Promise<void> {
  await openTabMenu(tab);
  await clickWhenShown(`tab-menu-${item}`);
  await gone(`tab-menu-${item}`);
}

/** Whether a menu item is disabled, and the reason its tooltip gives. */
export async function menuItemState(id: string): Promise<{ disabled: boolean; reason: string | null }> {
  const item = await shown(id);
  return {
    disabled: (await item.getAttribute("data-disabled")) !== null,
    reason: await item.getAttribute("title"),
  };
}

/** The status bar's count of this window's panes and tabs, such as "2 panes · 5 tabs". */
export async function layoutCount(): Promise<string> {
  return byTestId("status-layout").getText();
}
