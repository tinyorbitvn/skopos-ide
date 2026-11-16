import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import {
  buildFilterIndex,
  filterText,
  LAST_APPLIED,
  type ObjectFilter,
} from "./filter";
import { FILTER_LABEL, PropertyFilter } from "./PropertyFilter";

function pod(
  name: string,
  labels: Record<string, string> = {},
  annotations: Record<string, string> = {},
  namespace = "shop",
): KubeObject {
  return { metadata: { name, namespace, labels, annotations } };
}

/** Label keys by count: tier 3, app 2, then k1 … k8 once each. */
const OBJECTS: KubeObject[] = [
  pod(
    "web-1",
    { tier: "web", app: "web", k1: "a", k2: "a", k3: "a" },
    { "prometheus.io/scrape": "true", [LAST_APPLIED]: "{}" },
  ),
  pod(
    "web-2",
    { tier: "web", app: "web", k4: "a", k5: "a", k6: "a" },
    { "prometheus.io/scrape": "true", note: "" },
  ),
  pod("db-1", { tier: "", k7: "a", k8: "a" }, {}, "ops"),
];

const label = (
  key: string,
  operator: ObjectFilter["operator"],
  value: string,
) => ({ property: { type: "label", key }, operator, value }) as ObjectFilter;

function Harness(props: { objects?: KubeObject[]; tokens?: ObjectFilter[] }) {
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<ObjectFilter[]>(props.tokens ?? []);
  const index = useMemo(
    () => buildFilterIndex(props.objects ?? OBJECTS),
    [props.objects],
  );
  return (
    <>
      <PropertyFilter
        text={text}
        onTextChange={setText}
        tokens={tokens}
        onTokensChange={setTokens}
        index={index}
      />
      <output data-testid="tokens">{tokens.map(filterText).join(" | ")}</output>
      <button type="button">elsewhere</button>
    </>
  );
}

const box = () => screen.getByTestId("resource-search") as HTMLInputElement;
const list = () => screen.queryByTestId("filter-suggestions");
const tokens = () => screen.getByTestId("tokens").textContent;

/** Each option's main text, in order. */
function optionTexts(within_: HTMLElement | null = list()): string[] {
  if (!within_) return [];
  return within(within_)
    .queryAllByRole("option")
    .map((o) => o.firstElementChild?.textContent ?? "");
}

/** [heading, [main, hint][]] for each group. */
function groups(): [string, [string, string][]][] {
  return within(list() as HTMLElement)
    .getAllByRole("group")
    .map((g) => [
      g.getAttribute("aria-labelledby")
        ? (document.getElementById(g.getAttribute("aria-labelledby") ?? "")
            ?.textContent ?? "")
        : "",
      within(g)
        .getAllByRole("option")
        .map((o) => [
          o.firstElementChild?.textContent ?? "",
          o.lastElementChild?.textContent ?? "",
        ]),
    ]);
}

const foot = () => screen.getByTestId("filter-foot").textContent;

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

function key(name: string) {
  fireEvent.keyDown(box(), { key: name });
}

function pick(text: string) {
  const option = within(list() as HTMLElement)
    .getAllByRole("option")
    .find((o) => o.firstElementChild?.textContent === text);
  if (!option)
    throw new Error(`no option ${text}: ${optionTexts().join(", ")}`);
  fireEvent.pointerDown(option);
}

function focusBox() {
  act(() => box().focus());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PropertyFilter", () => {
  test("the box is a combobox labelled for the filter, with the test id the list's search had", () => {
    render(<Harness />);
    const input = box();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-label")).toBe(FILTER_LABEL);
    expect(input.placeholder).toBe(
      "Filter by name, namespace, label or annotation",
    );
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(list()).toBeNull();
  });

  test("with a token the placeholder asks for another", () => {
    render(<Harness tokens={[label("tier", "=", "web")]} />);
    expect(box().placeholder).toBe("Add a filter");
  });

  test("focus opens the property stage: properties, label keys and annotation keys, most common first, eight at most", () => {
    render(<Harness />);
    focusBox();
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-controls")).toBe(list()?.id);
    expect(list()?.getAttribute("role")).toBe("listbox");
    expect(groups()).toEqual([
      [
        "Properties",
        [
          ["Name", "Property"],
          ["Namespace", "Property"],
        ],
      ],
      [
        "Label keys",
        [
          ["label:tier", "3"],
          ["label:app", "2"],
          ["label:k1", "1"],
          ["label:k2", "1"],
          ["label:k3", "1"],
          ["label:k4", "1"],
          ["label:k5", "1"],
          ["label:k6", "1"],
        ],
      ],
      [
        "Annotation keys",
        [
          ["anno:prometheus.io/scrape", "2"],
          ["anno:note", "1"],
        ],
      ],
    ]);
    expect(foot()).toBe(
      "Pick a property or a key, or press Enter to search names, namespaces and labels",
    );
  });

  test("typed text comes first as Use, and narrows properties and keys", () => {
    render(<Harness />);
    focusBox();
    type("ti");
    expect(optionTexts()).toEqual(['Use: "ti"', "label:tier"]);
    const use = within(list() as HTMLElement).getAllByRole("option")[0];
    expect(use.lastElementChild?.textContent).toBe("Name, namespace or label");

    type("NAME");
    expect(optionTexts()).toEqual(['Use: "NAME"', "Name", "Namespace"]);

    type("pro");
    expect(groups().map(([heading]) => heading)).toEqual(["Annotation keys"]);
  });

  test("label: and anno: keep only their own keys, matched on the rest", () => {
    render(<Harness />);
    focusBox();
    type("label:");
    expect(groups().map(([heading]) => heading)).toEqual(["Label keys"]);
    type("label:K");
    expect(optionTexts()).toEqual([
      'Use: "label:K"',
      "label:k1",
      "label:k2",
      "label:k3",
      "label:k4",
      "label:k5",
      "label:k6",
      "label:k7",
      "label:k8",
    ]);
    type("anno:sc");
    expect(groups()).toEqual([
      ["Annotation keys", [["anno:prometheus.io/scrape", "2"]]],
    ]);
  });

  test("picking a key gives the operator stage, and an operator the value stage", () => {
    render(<Harness />);
    focusBox();
    pick("label:tier");
    expect(box().value).toBe("label:tier ");
    expect(groups()).toEqual([
      [
        "Operators",
        [
          ["=", "Equals"],
          ["!=", "Does not equal"],
          [":", "Contains"],
          ["!:", "Does not contain"],
        ],
      ],
    ]);
    expect(foot()).toBe("Choose how label:tier compares");

    pick("=");
    expect(box().value).toBe("label:tier = ");
    expect(groups()).toEqual([
      [
        "Values of label:tier",
        [
          ["web", "2"],
          ["(empty)", "1"],
        ],
      ],
    ]);
    expect(optionTexts()).not.toContain("Any value");
    expect(foot()).toBe("Enter adds the filter");
  });

  test("picking a property gives its operators", () => {
    render(<Harness />);
    focusBox();
    pick("Namespace");
    expect(box().value).toBe("namespace ");
    expect(foot()).toBe("Choose how namespace compares");
  });

  test("a value adds the filter, clears the text, keeps focus and shows the property stage again", () => {
    render(<Harness />);
    focusBox();
    type("label:tier = ");
    pick("web");
    expect(tokens()).toBe("label:tier = web");
    expect(box().value).toBe("");
    expect(document.activeElement).toBe(box());
    expect(groups()[0][0]).toBe("Properties");
  });

  test("Any value comes first for a label or annotation with : or !: and nothing typed", () => {
    render(<Harness />);
    focusBox();
    type("anno:note :");
    expect(optionTexts()).toEqual(["Any value", "(empty)"]);
    pick("Any value");
    expect(tokens()).toBe("anno:note :");

    type("label:tier !: ");
    expect(optionTexts()[0]).toBe("Any value");
    type("name : ");
    expect(optionTexts()).not.toContain("Any value");
  });

  test("a typed value comes first as Use, and narrows the values", () => {
    render(<Harness />);
    focusBox();
    type("label:app : W");
    expect(optionTexts()).toEqual(['Use: "W"', "web"]);
    pick('Use: "W"');
    expect(tokens()).toBe("label:app : W");
  });

  test("values are capped at eight, most common first, then by value", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      pod(`p${String(i).padStart(2, "0")}`),
    );
    render(<Harness objects={[...many, pod("p05", {}, {}, "other")]} />);
    focusBox();
    type("name = ");
    expect(groups()).toEqual([
      [
        "Values of name",
        [
          ["p05", "2"],
          ["p00", "1"],
          ["p01", "1"],
          ["p02", "1"],
          ["p03", "1"],
          ["p04", "1"],
          ["p06", "1"],
          ["p07", "1"],
        ],
      ],
    ]);
  });

  test("a property with no values in the list says so", () => {
    render(<Harness />);
    focusBox();
    type("label:absent = ");
    expect(optionTexts()).toEqual([]);
    expect(foot()).toBe("label:absent has no values in this list");
  });

  test("the last-applied annotation is never suggested", () => {
    render(<Harness />);
    focusBox();
    type("anno:");
    expect(optionTexts()).not.toContain(`anno:${LAST_APPLIED}`);
  });

  test("↓ and ↑ move the active option, wrapping, and aria-activedescendant follows", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<Harness />);
    focusBox();
    type("label:app ");
    const options = () => within(list() as HTMLElement).getAllByRole("option");
    const active = () => box().getAttribute("aria-activedescendant");
    expect(active()).toBe(options()[0].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");

    key("ArrowDown");
    expect(active()).toBe(options()[1].id);
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(options()[0].getAttribute("aria-selected")).toBe("false");
    expect(scroll.mock.contexts.at(-1)).toBe(options()[1]);

    key("ArrowUp");
    key("ArrowUp");
    expect(active()).toBe(options()[3].id);
    key("ArrowDown");
    expect(active()).toBe(options()[0].id);
  });

  test("the first option is active again whenever the options change", () => {
    render(<Harness />);
    focusBox();
    key("ArrowDown");
    key("ArrowDown");
    type("label:");
    const first = within(list() as HTMLElement).getAllByRole("option")[0];
    expect(box().getAttribute("aria-activedescendant")).toBe(first.id);
  });

  test("Enter picks the active option", () => {
    render(<Harness />);
    focusBox();
    type("label:app ");
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    expect(box().value).toBe("label:app : ");
    key("Enter");
    expect(tokens()).toBe("label:app :");
  });

  test("Enter on typed text keeps it as a token, and with no options adds what parseFilter gives", () => {
    render(<Harness />);
    focusBox();
    type("app=web");
    key("Enter");
    expect(tokens()).toBe('"app=web"');

    type("label:x = y");
    key("Escape");
    expect(list()).toBeNull();
    key("Enter");
    expect(tokens()).toBe('"app=web" | label:x = y');
    expect(box().value).toBe("");

    type("label:x =");
    key("Escape");
    key("Enter");
    expect(tokens()).toBe('"app=web" | label:x = y');
    expect(box().value).toBe("label:x =");
  });

  test("Escape closes the suggestions, then clears the text", () => {
    render(<Harness />);
    focusBox();
    type("web");
    key("Escape");
    expect(list()).toBeNull();
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(box().value).toBe("web");
    key("Escape");
    expect(box().value).toBe("");
    type("w");
    expect(list()).not.toBeNull();
  });

  test("Backspace with no text removes the last token, and with text edits the text", () => {
    render(<Harness tokens={[label("a", "=", "1"), label("b", "=", "2")]} />);
    focusBox();
    type("x");
    key("Backspace");
    expect(tokens()).toBe("label:a = 1 | label:b = 2");
    type("");
    key("Backspace");
    expect(tokens()).toBe("label:a = 1");
    key("Backspace");
    key("Backspace");
    expect(tokens()).toBe("");
  });

  test("Tab and blur close the suggestions, and ↓ opens them again", () => {
    render(<Harness />);
    focusBox();
    key("Tab");
    expect(list()).toBeNull();
    key("ArrowDown");
    expect(list()).not.toBeNull();
    expect(box().getAttribute("aria-activedescendant")).toBe(
      within(list() as HTMLElement).getAllByRole("option")[0].id,
    );
    act(() => box().blur());
    expect(list()).toBeNull();
    expect(box().getAttribute("aria-activedescendant")).toBeNull();
  });

  test("a pointer pick acts on pointerdown and keeps focus in the box", () => {
    render(<Harness />);
    focusBox();
    const name = within(list() as HTMLElement).getAllByRole("option")[0];
    expect(name.tagName).toBe("BUTTON");
    expect(name.getAttribute("tabindex")).toBe("-1");
    // The mouse down that follows is cancelled, so the box never loses focus.
    expect(fireEvent.mouseDown(name)).toBe(false);
    fireEvent.pointerDown(name);
    expect(box().value).toBe("name ");
    expect(document.activeElement).toBe(box());
    expect(list()).not.toBeNull();
  });
});
