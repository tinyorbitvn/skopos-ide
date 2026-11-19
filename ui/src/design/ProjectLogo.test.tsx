import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { CSS_FILES, cssRules } from "../test/css";
import { ProjectLogo } from "./ProjectLogo";

/** The logo files as they sit in the source tree. */
const LOGOS: Record<string, string> = import.meta.glob<string>(
  "/src/design/logos/*.svg",
  { query: "?raw", import: "default", eager: true },
);

test("each logo shows its light and dark file, hidden from assistive technology", () => {
  const files = (name: "helm" | "argo") => {
    const { container } = render(<ProjectLogo name={name} size={16} />);
    const box = container.firstElementChild as HTMLElement;
    expect([box.getAttribute("aria-hidden"), box.dataset.logo]).toEqual([
      "true",
      name,
    ]);
    expect([box.style.width, box.style.height]).toEqual(["16px", "16px"]);
    return [...box.querySelectorAll("img")].map((img) => [
      img.className,
      img.getAttribute("alt"),
      (img.getAttribute("src") ?? "").split("/").at(-1),
    ]);
  };
  expect(files("helm")).toEqual([
    ["light", "", "helm-icon-color.svg"],
    ["dark", "", "helm-icon-white.svg"],
  ]);
  expect(files("argo")).toEqual([
    ["light", "", "argo-icon-black.svg"],
    ["dark", "", "argo-icon-white.svg"],
  ]);
});

test("the logo files are the CNCF artwork, with no prolog, comment or editor metadata", () => {
  expect(Object.keys(LOGOS).sort()).toEqual([
    "/src/design/logos/argo-icon-black.svg",
    "/src/design/logos/argo-icon-white.svg",
    "/src/design/logos/helm-icon-color.svg",
    "/src/design/logos/helm-icon-white.svg",
  ]);
  for (const [path, svg] of Object.entries(LOGOS)) {
    expect([path, svg.startsWith("<svg ")]).toEqual([path, true]);
    for (const banned of ["<?xml", "<!--", "Layer_1", "data-name"]) {
      expect([path, banned, svg.includes(banned)]).toEqual([
        path,
        banned,
        false,
      ]);
    }
  }
  const fill = (name: string, part: string) =>
    LOGOS[`/src/design/logos/${name}`]?.includes(part);
  expect(fill("helm-icon-color.svg", ".cls-1{fill:#0f1689;}")).toBe(true);
  expect(fill("helm-icon-white.svg", ".cls-1{fill:#fff;}")).toBe(true);
  expect(fill("argo-icon-black.svg", 'fill="#000"')).toBe(true);
  expect(fill("argo-icon-white.svg", 'fill="#fff"')).toBe(true);
});

test("the light file shows in the light theme and the dark file in the dark one", () => {
  const rules = cssRules(CSS_FILES["/src/design/ProjectLogo.module.css"]);
  const display = (selector: string) =>
    rules
      .find((r) => r.selector === selector)
      ?.decls.find(([p]) => p === "display")?.[1];
  expect(display(".dark")).toBe("none");
  expect(display(':global([data-theme="dark"]) .light')).toBe("none");
  expect(display(':global([data-theme="dark"]) .dark')).toBe("block");
});
