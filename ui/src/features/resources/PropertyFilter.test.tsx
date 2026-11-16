import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo, useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import { FilterTokens } from "./FilterTokens";
import {
  buildFilterIndex,
  type FilterJoin,
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

/** The box and the row of tokens, wired as `ResourceScreen` wires them. */
function Row(props: { tokens: ObjectFilter[]; text?: string }) {
  const [text, setText] = useState(props.text ?? "");
  const [tokens, setTokens] = useState<ObjectFilter[]>(props.tokens);
  const [join, setJoin] = useState<FilterJoin>("and");
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => buildFilterIndex(OBJECTS), []);
  return (
    <>
      <PropertyFilter
        text={text}
        onTextChange={setText}
        tokens={tokens}
        onTokensChange={setTokens}
        index={index}
        inputRef={inputRef}
      />
      <FilterTokens
        tokens={tokens}
        onTokensChange={setTokens}
        join={join}
        onJoinChange={setJoin}
        onClear={() => {
          setTokens([]);
          setText("");
        }}
        shown={2}
        total={3}
        onFocusBox={() => inputRef.current?.focus()}
      />
      <output data-testid="tokens">{tokens.map(filterText).join(" | ")}</output>
      <output data-testid="join">{join}</output>
      <button type="button">elsewhere</button>
    </>
  );
}

const TIER_WEB = label("tier", "=", "web");
const byId = (id: string) => screen.getByTestId(id);
const panel = () => screen.queryByTestId("filter-edit");

function openEdit(at: number): HTMLElement {
  fireEvent.click(byId(`filter-token-edit-${at}`));
  return screen.getByRole("dialog", { name: "Edit filter" });
}

function valueBox(): HTMLInputElement {
  return byId("filter-edit-value") as HTMLInputElement;
}

describe("FilterTokens", () => {
  test("there is no row without a token", () => {
    render(<Row tokens={[]} />);
    expect(screen.queryByTestId("filter-tokens")).toBeNull();
  });

  test("each token shows its property, operator and value, with edit and remove buttons named by its text form", () => {
    const long = "x".repeat(60);
    render(
      <Row
        tokens={[
          TIER_WEB,
          {
            property: { type: "annotation", key: "note" },
            operator: ":",
            value: "",
          },
          { property: { type: "name" }, operator: "=", value: long },
          { property: { type: "text" }, operator: ":", value: "web" },
          { property: { type: "text" }, operator: "!:", value: "db" },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "Filters" })).toBe(
      byId("filter-tokens"),
    );
    const edit = (i: number) => byId(`filter-token-edit-${i}`);
    expect(edit(0).textContent).toBe("label:tier=web");
    expect(edit(0).getAttribute("aria-label")).toBe(
      "Edit filter label:tier = web",
    );
    expect(byId("filter-token-remove-0").getAttribute("aria-label")).toBe(
      "Remove filter label:tier = web",
    );
    expect(edit(1).textContent).toBe("anno:note:any value");
    const cut = within(edit(2)).getByTitle(long);
    expect(cut.textContent).toBe(`${"x".repeat(48)}…`);
    expect(edit(3).textContent).toBe('"web"');
    expect(edit(3).getAttribute("aria-label")).toBe('Edit filter "web"');
    expect(edit(4).textContent).toBe('not"db"');
    expect(byId("filter-token-remove-4").getAttribute("aria-label")).toBe(
      'Remove filter not "db"',
    );
  });

  test("a join sits before each token from the second on, and pressing one switches every join", () => {
    render(
      <Row tokens={[TIER_WEB, label("a", "=", "1"), label("b", "=", "2")]} />,
    );
    expect(screen.queryByTestId("filter-join-0")).toBeNull();
    for (const i of [1, 2]) {
      expect(byId(`filter-join-${i}`).textContent).toBe("and");
      expect(byId(`filter-join-${i}`).title).toBe(
        "Rows match every filter. Click to match any filter.",
      );
    }
    fireEvent.click(byId("filter-join-2"));
    expect(byId("join").textContent).toBe("or");
    for (const i of [1, 2]) {
      expect(byId(`filter-join-${i}`).textContent).toBe("or");
      expect(byId(`filter-join-${i}`).title).toBe(
        "Rows match any filter. Click to match every filter.",
      );
    }
    fireEvent.click(byId("filter-join-1"));
    expect(byId("join").textContent).toBe("and");
  });

  test("the count reads shown of total", () => {
    render(<Row tokens={[TIER_WEB]} />);
    expect(byId("filter-count").textContent).toBe("2 of 3");
  });

  test("remove takes one token out and puts focus in the box", () => {
    render(<Row tokens={[TIER_WEB, label("b", "=", "2")]} />);
    fireEvent.click(byId("filter-token-remove-0"));
    expect(tokens()).toBe("label:b = 2");
    expect(document.activeElement).toBe(box());
  });

  test("Clear filters removes every token and the text, and puts focus in the box", () => {
    render(<Row tokens={[TIER_WEB, label("b", "=", "2")]} text="typed" />);
    fireEvent.click(byId("filter-clear"));
    expect(tokens()).toBe("");
    expect(box().value).toBe("");
    expect(screen.queryByTestId("filter-tokens")).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  test("the edit button opens the panel: the property in words, its operators, and the value focused", () => {
    render(
      <Row
        tokens={[
          TIER_WEB,
          { property: { type: "text" }, operator: ":", value: "api" },
        ]}
      />,
    );
    const edit = openEdit(0);
    expect(byId("filter-token-edit-0").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(byId("filter-token-0").getAttribute("data-editing")).toBe("true");
    expect(within(edit).getByText("Label tier")).toBeTruthy();
    const radios = within(edit).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      "=",
      "!=",
      ":",
      "!:",
    ]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
    expect(byId("filter-edit-operator-not-equals")).toBeTruthy();
    expect(valueBox().value).toBe("web");
    expect(document.activeElement).toBe(valueBox());

    fireEvent.click(byId("filter-edit-cancel"));
    const text = openEdit(1);
    expect(within(text).getByText("Free text")).toBeTruthy();
    expect(
      within(text)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).labels?.[0]?.textContent),
    ).toEqual([":", "!:"]);
  });

  test("Apply saves the operator and the trimmed value, and focus returns to the token", () => {
    render(<Row tokens={[TIER_WEB]} />);
    const edit = openEdit(0);
    fireEvent.click(within(edit).getByRole("radio", { name: "!=" }));
    fireEvent.change(valueBox(), { target: { value: "  api " } });
    fireEvent.click(byId("filter-edit-apply"));
    expect(tokens()).toBe("label:tier != api");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(byId("filter-token-edit-0"));
  });

  test("Enter in the value applies", () => {
    render(<Row tokens={[TIER_WEB]} />);
    openEdit(0);
    fireEvent.change(valueBox(), { target: { value: "db" } });
    fireEvent.keyDown(valueBox(), { key: "Enter" });
    expect(tokens()).toBe("label:tier = db");
    expect(panel()).toBeNull();
  });

  test("an empty value removes the token, and focus goes to the box", () => {
    render(
      <Row
        tokens={[
          { property: { type: "name" }, operator: "=", value: "x" },
          label("b", "=", "2"),
        ]}
      />,
    );
    openEdit(0);
    fireEvent.change(valueBox(), { target: { value: "   " } });
    fireEvent.click(byId("filter-edit-apply"));
    expect(tokens()).toBe("label:b = 2");
    expect(document.activeElement).toBe(box());
  });

  test("an empty value with : or !: on a label or annotation means any value", () => {
    render(<Row tokens={[TIER_WEB]} />);
    const edit = openEdit(0);
    fireEvent.click(within(edit).getByRole("radio", { name: "!:" }));
    fireEvent.change(valueBox(), { target: { value: "" } });
    fireEvent.click(byId("filter-edit-apply"));
    expect(tokens()).toBe("label:tier !:");
    expect(byId("filter-token-edit-0").textContent).toBe(
      "label:tier!:any value",
    );
  });

  test("Cancel and Escape keep the token and return focus to it; Escape goes no further than the panel", () => {
    const outer = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: the test listens for keys that leave the panel.
      <div onKeyDown={(e) => outer(e.key)}>
        <Row tokens={[TIER_WEB]} />
      </div>,
    );
    let edit = openEdit(0);
    fireEvent.click(within(edit).getByRole("radio", { name: ":" }));
    fireEvent.change(valueBox(), { target: { value: "db" } });
    fireEvent.click(byId("filter-edit-cancel"));
    expect(tokens()).toBe("label:tier = web");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(byId("filter-token-edit-0"));

    edit = openEdit(0);
    expect(valueBox().value).toBe("web");
    fireEvent.change(valueBox(), { target: { value: "db" } });
    fireEvent.keyDown(valueBox(), { key: "Escape" });
    expect(tokens()).toBe("label:tier = web");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(byId("filter-token-edit-0"));
    expect(outer).not.toHaveBeenCalledWith("Escape");
  });

  test("a pointer down outside the token cancels; inside the panel it does not", () => {
    render(<Row tokens={[TIER_WEB]} />);
    const edit = openEdit(0);
    fireEvent.change(valueBox(), { target: { value: "db" } });
    fireEvent.pointerDown(within(edit).getByRole("radio", { name: "!=" }));
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(panel()).toBeNull();
    expect(tokens()).toBe("label:tier = web");
  });

  test("the edit button closes its open panel", () => {
    render(<Row tokens={[TIER_WEB]} />);
    openEdit(0);
    fireEvent.click(byId("filter-token-edit-0"));
    expect(panel()).toBeNull();
  });
});
