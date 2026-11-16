import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CSS_FILES, cssRules } from "../test/css";
import { Tooltip } from "./Tooltip";

/** The tooltip's styled panel, inside Radix's positioning wrapper. */
function panel(): HTMLElement {
  const el = document.querySelector("[data-radix-popper-content-wrapper] > *");
  if (!(el instanceof HTMLElement)) throw new Error("no tooltip panel");
  return el;
}

test("a label tooltip keeps the inverse surface and announces its content", async () => {
  render(
    <Tooltip content="Copy the name">
      <button type="button">Copy</button>
    </Tooltip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Copy" }));
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe("Copy the name");
  expect(panel().classList.contains("content")).toBe(true);
  expect(panel().classList.contains("card")).toBe(false);
});

test("a card tooltip uses the card panel and announces its label once", async () => {
  render(
    <Tooltip
      variant="card"
      label="Ready; Running 3"
      content={<div data-testid="card-body">web — 3 Pods</div>}
    >
      <button type="button">Ready</button>
    </Tooltip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Ready" }));
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe("Ready; Running 3");
  expect(screen.getAllByTestId("card-body")).toHaveLength(1);
  expect(panel().classList.contains("content")).toBe(true);
  expect(panel().classList.contains("card")).toBe(true);
});

test("the card follows the theme on the raised surface", () => {
  const rules = cssRules(CSS_FILES["/src/design/Tooltip.module.css"] ?? "");
  const card = Object.fromEntries(
    rules.find((r) => r.selector === ".card")?.decls ?? [],
  );
  expect(card).toMatchObject({
    background: "var(--surface-raised)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
    "border-radius": "var(--radius-md)",
    "box-shadow": "var(--shadow-3)",
  });
  const label = Object.fromEntries(
    rules.find((r) => r.selector === ".content")?.decls ?? [],
  );
  expect(label.background).toBe("var(--surface-inverse)");
});
