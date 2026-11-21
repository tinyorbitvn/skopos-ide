import { expect, test } from "vitest";
import { carriesFileOrLink, installDropGuard } from "./dropGuard";

function drag(type: "dragover" | "drop", types: string[]): Event {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, dropEffect: "copy" },
  });
  return event;
}

test("a drag carries a file or a link when its types say so", () => {
  expect(carriesFileOrLink(["Files"])).toBe(true);
  expect(carriesFileOrLink(["text/plain", "text/uri-list"])).toBe(true);
  expect(carriesFileOrLink(["text/plain"])).toBe(false);
  expect(carriesFileOrLink([])).toBe(false);
});

test("a dropped file is default-prevented, and a dropped piece of text is left alone", () => {
  const remove = installDropGuard(window);
  const file = drag("drop", ["Files"]);
  window.dispatchEvent(file);
  expect(file.defaultPrevented).toBe(true);
  const text = drag("drop", ["text/plain"]);
  window.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  remove();
});

test("a drag over the window with a link shows that nothing can be dropped", () => {
  const remove = installDropGuard(window);
  const over = drag("dragover", ["text/uri-list"]);
  window.dispatchEvent(over);
  expect(over.defaultPrevented).toBe(true);
  expect((over as unknown as DragEvent).dataTransfer?.dropEffect).toBe("none");
  const text = drag("dragover", ["text/plain"]);
  window.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  expect((text as unknown as DragEvent).dataTransfer?.dropEffect).toBe("copy");
  remove();
});

test("after the returned function runs, a dropped file is no longer prevented", () => {
  installDropGuard(window)();
  const file = drag("drop", ["Files"]);
  window.dispatchEvent(file);
  expect(file.defaultPrevented).toBe(false);
});
