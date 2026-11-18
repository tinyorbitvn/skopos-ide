import { mockWindows } from "@tauri-apps/api/mocks";
import { expect, test } from "vitest";
import { MAIN_WINDOW, windowLabel } from "./window";

test("windowLabel is the label Tauri gave this window", () => {
  mockWindows("window-4");
  expect(windowLabel()).toBe("window-4");
});

test("windowLabel is main when Tauri names no window", () => {
  expect(windowLabel()).toBe(MAIN_WINDOW);
  expect(MAIN_WINDOW).toBe("main");
});
