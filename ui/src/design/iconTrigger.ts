/** What an animated icon exposes: play its motion once, or put it back at rest. */
export interface IconAnimation {
  startAnimation(): void;
  stopAnimation(): void;
}

/**
 * The controls whose hover or keyboard focus plays the icons inside them: buttons and icon
 * buttons, links, menu items, tabs, options and tree items. An icon anywhere else stays still.
 */
export const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="treeitem"]',
  "summary",
].join(", ");

/**
 * True while the system asks for reduced motion. The app has no motion setting of its own,
 * so this is the one switch; it is read each time, so a change applies at once.
 */
export function motionReduced(): boolean {
  try {
    return (
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
    );
  } catch {
    return false;
  }
}

function inactive(control: Element): boolean {
  return control.matches(':disabled, [aria-disabled="true"], [data-disabled]');
}

/**
 * Whether the last input was a key press, so a focus that follows is keyboard focus and not
 * the focus a click brings along. Tracked on the document once, from the first binding.
 */
let keyboardInput = false;
let tracking = false;

function trackInput(): void {
  if (tracking) return;
  tracking = true;
  const keyboard = () => {
    keyboardInput = true;
  };
  const pointer = () => {
    keyboardInput = false;
  };
  document.addEventListener("keydown", keyboard, true);
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("mousedown", pointer, true);
}

/**
 * Plays the icon's motion while the control that holds `icon` is hovered or has keyboard
 * focus, and puts it back at rest when neither holds. Nothing plays while the control is
 * disabled or reduced motion is on. Returns the function that unbinds it.
 */
export function bindToControl(
  icon: Element,
  animation: () => IconAnimation | null,
): () => void {
  const control = icon.parentElement?.closest(CONTROL_SELECTOR);
  if (!control) return () => {};
  trackInput();
  let hovered = false;
  let focused = false;
  let playing = false;
  const sync = () => {
    const play =
      (hovered || focused) &&
      !playing &&
      !inactive(control) &&
      !motionReduced();
    if (play) {
      playing = true;
      animation()?.startAnimation();
    } else if (playing && !hovered && !focused) {
      playing = false;
      animation()?.stopAnimation();
    }
  };
  const enter = () => {
    hovered = true;
    sync();
  };
  const leave = () => {
    hovered = false;
    sync();
  };
  const focusIn = () => {
    focused = keyboardInput;
    sync();
  };
  const focusOut = (event: Event) => {
    const next = (event as FocusEvent).relatedTarget;
    if (next instanceof Node && control.contains(next)) return;
    focused = false;
    sync();
  };
  control.addEventListener("mouseenter", enter);
  control.addEventListener("mouseleave", leave);
  control.addEventListener("focusin", focusIn);
  control.addEventListener("focusout", focusOut);
  return () => {
    control.removeEventListener("mouseenter", enter);
    control.removeEventListener("mouseleave", leave);
    control.removeEventListener("focusin", focusIn);
    control.removeEventListener("focusout", focusOut);
  };
}
