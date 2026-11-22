import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo, useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TableColumn } from "../../design/VirtualTable";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  baseColumns,
  numberColumn,
  statusColumn,
  textColumn,
} from "../../kinds/columns";
import type { KubeObject } from "../../kinds/objects";
import { defaultColumns } from "../../kinds/registry";
import { filterColumns } from "./columnFilter";
import { FilterTokens } from "./FilterTokens";
import {
  buildFilterIndex,
  type FilterContext,
  type FilterJoin,
  filterContext,
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

const NOW = Date.parse("2026-11-22T12:00:00Z");
const POD_REF: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
/** Name and Namespace only, so the tests of labels and annotations read as before. */
const NAME_COLUMNS = defaultColumns(POD_REF).filter((c) => c.id !== "age");
const POD_COLUMNS = baseColumns(
  POD_REF,
  statusColumn((o) => ({ label: o.status?.phase ?? "Unknown", tone: "ok" })),
  numberColumn("restarts", "Restarts", (o) => o.status?.restarts),
  textColumn("ip", "IP", (o) => o.status?.podIP),
);
const PODS: KubeObject[] = [
  {
    metadata: { name: "web-1", namespace: "shop" },
    status: { phase: "Running", restarts: 2, podIP: "10.0.0.1" },
  },
  {
    metadata: { name: "web-2", namespace: "shop" },
    status: { phase: "Running", podIP: "10.0.0.2" },
  },
  {
    metadata: { name: "db-1", namespace: "ops" },
    status: { phase: "Pending" },
  },
];

function contextOf(
  columns: TableColumn<KubeObject>[] = NAME_COLUMNS,
  hidden: string[] = [],
): FilterContext {
  return filterContext(filterColumns(columns, hidden), NOW);
}

function Harness(props: {
  objects?: KubeObject[];
  tokens?: ObjectFilter[];
  columns?: TableColumn<KubeObject>[];
  hidden?: string[];
}) {
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<ObjectFilter[]>(props.tokens ?? []);
  const context = useMemo(
    () => contextOf(props.columns, props.hidden),
    [props.columns, props.hidden],
  );
  const index = useMemo(
    () => buildFilterIndex(props.objects ?? OBJECTS, context),
    [props.objects, context],
  );
  return (
    <>
      <PropertyFilter
        text={text}
        onTextChange={setText}
        tokens={tokens}
        onTokensChange={setTokens}
        index={index}
        context={context}
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
    expect(input.placeholder).toBe("Filter by any column, label or annotation");
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
        "Columns",
        [
          ["Name", "Column"],
          ["Namespace", "Column"],
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
      "Pick a column or a key, or press Enter to search every column and label",
    );
  });

  test("typed text comes first as Use, and narrows properties and keys", () => {
    render(<Harness />);
    focusBox();
    type("ti");
    expect(optionTexts()).toEqual(['Use: "ti"', "label:tier"]);
    const use = within(list() as HTMLElement).getAllByRole("option")[0];
    expect(use.lastElementChild?.textContent).toBe("Any column or label");

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
    expect(groups()[0][0]).toBe("Columns");
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

  test("an equal but new index keeps the active option; changed options reset it", () => {
    const { rerender } = render(<Harness objects={[...OBJECTS]} />);
    focusBox();
    key("ArrowDown");
    key("ArrowDown");
    const active = () => box().getAttribute("aria-activedescendant");
    const options = () => within(list() as HTMLElement).getAllByRole("option");
    const before = optionTexts();
    expect(active()).toBe(options()[2].id);
    rerender(<Harness objects={[...OBJECTS]} />);
    expect(optionTexts()).toEqual(before);
    expect(active()).toBe(options()[2].id);
    expect(options()[2].getAttribute("aria-selected")).toBe("true");
    rerender(<Harness objects={OBJECTS.slice(0, 1)} />);
    expect(active()).toBe(options()[0].id);
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

  test("the Columns group lists every column in table order, the hidden ones too", () => {
    render(<Harness objects={PODS} columns={POD_COLUMNS} hidden={["ip"]} />);
    focusBox();
    expect(groups()[0]).toEqual([
      "Columns",
      [
        ["Name", "Column"],
        ["Namespace", "Column"],
        ["Status", "Column"],
        ["Restarts", "Column"],
        ["IP", "Hidden column"],
        ["Age", "Column"],
      ],
    ]);
    type("re");
    expect(groups()[0][1].map(([main]) => main)).toEqual(["Restarts"]);
  });

  test("a column's operators: four for text, > and < for numbers, Longer and Shorter than for times", () => {
    render(<Harness objects={PODS} columns={POD_COLUMNS} />);
    focusBox();
    type("Sta");
    pick("Status");
    expect(box().value).toBe("status ");
    expect(groups()[0][1].map(([main]) => main)).toEqual([
      "=",
      "!=",
      ":",
      "!:",
    ]);
    expect(foot()).toBe("Choose how status compares");

    type("restarts ");
    expect(groups()[0][1]).toEqual([
      ["=", "Equals"],
      ["!=", "Does not equal"],
      [":", "Contains"],
      ["!:", "Does not contain"],
      [">", "Greater than"],
      ["<", "Less than"],
    ]);

    type("age ");
    expect(groups()[0][1].slice(4)).toEqual([
      [">", "Longer than"],
      ["<", "Shorter than"],
    ]);
  });

  test("a column's values come with their counts; a time column lists none", () => {
    render(<Harness objects={PODS} columns={POD_COLUMNS} />);
    focusBox();
    type("status = ");
    expect(groups()).toEqual([
      [
        "Values of status",
        [
          ["Running", "2"],
          ["Pending", "1"],
        ],
      ],
    ]);
    expect(foot()).toBe("Enter adds the filter");
    pick("Running");
    expect(tokens()).toBe("status = Running");

    type("age = ");
    expect(optionTexts()).toEqual([]);
    expect(foot()).toBe("Type the text the column shows, such as 3d");

    type("ip : ");
    expect(optionTexts()[0]).toBe("Any value");
  });

  test("> and < offer the value only when it is a number or a time, and say what to type", () => {
    render(<Harness objects={PODS} columns={POD_COLUMNS} />);
    focusBox();
    type("age < ");
    expect(optionTexts()).toEqual([]);
    expect(foot()).toBe("Type a time such as 30m, 2h or 7d");
    type("age < abc");
    expect(optionTexts()).toEqual([]);
    expect(foot()).toBe("Type a time such as 30m, 2h or 7d");
    key("Enter");
    expect(tokens()).toBe("");
    type("age < 1h");
    expect(optionTexts()).toEqual(['Use: "1h"']);
    expect(foot()).toBe("Enter adds the filter");
    key("Enter");
    expect(tokens()).toBe("age < 1h");

    type("restarts > many");
    expect(foot()).toBe("Type a number");
  });

  test("an operator the property does not take says which it takes", () => {
    render(<Harness objects={PODS} columns={POD_COLUMNS} />);
    focusBox();
    type("status > 1");
    expect(optionTexts()).toEqual([]);
    expect(foot()).toBe("status takes =, !=, : and !:");
    key("Enter");
    expect(tokens()).toBe("");
  });

  test("a key typed in capitals adds the column's token", () => {
    render(<Harness objects={PODS} columns={POD_COLUMNS} />);
    focusBox();
    type("STATUS = Running");
    key("Enter");
    expect(tokens()).toBe("status = Running");
  });
});

/** The box and the row of tokens, wired as `ResourceScreen` wires them. */
function Row(props: {
  tokens: ObjectFilter[];
  text?: string;
  context?: FilterContext;
}) {
  const [text, setText] = useState(props.text ?? "");
  const [tokens, setTokens] = useState<ObjectFilter[]>(props.tokens);
  const [join, setJoin] = useState<FilterJoin>("and");
  const inputRef = useRef<HTMLInputElement>(null);
  const own = useMemo(() => contextOf(), []);
  const context = props.context ?? own;
  const index = useMemo(() => buildFilterIndex(OBJECTS, context), [context]);
  return (
    <>
      <PropertyFilter
        text={text}
        onTextChange={setText}
        tokens={tokens}
        onTokensChange={setTokens}
        index={index}
        context={context}
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
        context={context}
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

  const AGE_UNDER_HOUR: ObjectFilter = {
    property: { type: "column", key: "age" },
    operator: "<",
    value: "1h",
  };

  test("a column token's panel names its header and offers its column's operators", () => {
    render(<Row tokens={[AGE_UNDER_HOUR]} context={contextOf(POD_COLUMNS)} />);
    const edit = openEdit(0);
    expect(within(edit).getByText("Age")).toBeTruthy();
    const radios = within(edit).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      "=",
      "!=",
      ":",
      "!:",
      ">",
      "<",
    ]);
    expect(radios.map((r) => r.checked)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(byId("filter-edit-operator-greater")).toBeTruthy();
  });

  test("an invalid time keeps the panel open with the error under the value", () => {
    render(<Row tokens={[AGE_UNDER_HOUR]} context={contextOf(POD_COLUMNS)} />);
    openEdit(0);
    fireEvent.change(valueBox(), { target: { value: "soon" } });
    fireEvent.click(byId("filter-edit-apply"));
    expect(panel()).toBeTruthy();
    expect(byId("filter-edit-error").textContent).toBe(
      "Type a time such as 30m, 2h or 7d",
    );
    expect(valueBox().getAttribute("aria-invalid")).toBe("true");
    expect(tokens()).toBe("age < 1h");

    fireEvent.change(valueBox(), { target: { value: "2h" } });
    expect(screen.queryByTestId("filter-edit-error")).toBeNull();
    fireEvent.click(byId("filter-edit-apply"));
    expect(tokens()).toBe("age < 2h");
    expect(panel()).toBeNull();
  });

  test("an empty value on : keeps a column token as any value", () => {
    const ip: ObjectFilter = {
      property: { type: "column", key: "ip" },
      operator: ":",
      value: "10.",
    };
    render(<Row tokens={[ip]} context={contextOf(POD_COLUMNS)} />);
    openEdit(0);
    fireEvent.change(valueBox(), { target: { value: "" } });
    fireEvent.click(byId("filter-edit-apply"));
    expect(tokens()).toBe("ip :");
  });

  test("a token whose column left the list takes the warning tone, and loses it when the column is back", () => {
    const cpu: ObjectFilter = {
      property: { type: "column", key: "restarts" },
      operator: ">",
      value: "0",
    };
    const { rerender } = render(<Row tokens={[cpu]} context={contextOf()} />);
    const token = byId("filter-token-0");
    expect(token.getAttribute("data-missing")).toBe("true");
    expect(token.title).toBe("This list has no column restarts");
    expect(within(openEdit(0)).getByText("restarts")).toBeTruthy();
    fireEvent.click(byId("filter-edit-cancel"));

    rerender(<Row tokens={[cpu]} context={contextOf(POD_COLUMNS)} />);
    expect(byId("filter-token-0").getAttribute("data-missing")).toBe("false");
    expect(byId("filter-token-0").title).toBe("");
  });
});
