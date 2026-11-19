import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { copyText } from "../../design/clipboard";
import { HardDrive } from "../../design/icons";
import { flush, mockBackend } from "../../test/ipc";
import {
  Chips,
  DrawerKindContext,
  ExpandRow,
  FactList,
  FactRow,
  Facts,
  Item,
  ItemList,
  Part,
  StatGrid,
  SubRow,
  sectionSlug,
  titleKey,
} from "./parts";

vi.mock("../../design/clipboard", () => ({ copyText: vi.fn() }));
const copied = vi.mocked(copyText);

afterEach(() => {
  vi.useRealTimers();
  copied.mockReset();
});

/** Presses the copy button of the field `label` and returns what it put on the clipboard. */
async function copyField(label: string): Promise<string> {
  copied.mockResolvedValue(undefined);
  const button = screen.getByRole("button", { name: `Copy ${label}` });
  await act(async () => {
    fireEvent.click(button);
  });
  return copied.mock.calls.at(-1)?.[0] ?? "";
}

test("every fact and container row copies the value it shows", async () => {
  render(
    <>
      <Facts
        items={[
          ["Node", "worker-1"],
          ["Empty", ""],
        ]}
      />
      <FactList>
        <FactRow label="Service account">default</FactRow>
        <FactRow label="Labels" copy={false}>
          None
        </FactRow>
      </FactList>
      <SubRow label="Image">
        <span>{"registry.k8s.io/\u200bpause:3.10"}</span>
      </SubRow>
      <SubRow label="Ports">
        <span>
          80/TCP{" "}
          <button type="button" data-copy-skip="">
            Forward
          </button>
        </span>
      </SubRow>
    </>,
  );
  expect(await copyField("Node")).toBe("worker-1");
  expect(screen.getByTestId("copy-field-node")).toBeTruthy();
  expect(await copyField("Service account")).toBe("default");
  // A row that says there is nothing has nothing to copy, nor does a fact left out.
  expect(screen.queryByRole("button", { name: "Copy Labels" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy Empty" })).toBeNull();
  // Not the hints that let a long path wrap, nor the controls beside the value.
  expect(await copyField("Image")).toBe("registry.k8s.io/pause:3.10");
  expect(await copyField("Ports")).toBe("80/TCP");
  // The copy that was read is gone from the page.
  expect(screen.getAllByText("80/TCP", { exact: false })).toHaveLength(1);
});

test("a value of several lines is copied a line each, without blank lines", async () => {
  // jsdom lays nothing out, so innerText reads here as a browser reads blocks: a line each.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return Array.from(this.children)
        .map((line) => `  ${line.textContent}  `)
        .join("\n\n");
    },
  });
  try {
    render(
      <SubRow label="Env">
        <span>A=1</span>
        <span>B=2</span>
      </SubRow>,
    );
    expect(await copyField("Env")).toBe("A=1\nB=2");
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "innerText");
  }
});

test("slugs and title keys", () => {
  expect(sectionSlug("Access Control")).toBe("access-control");
  expect(sectionSlug("Sources (2)")).toBe("sources-2-");
  expect(titleKey("Sources (2)")).toBe("Sources");
  expect(titleKey("Sources")).toBe("Sources");
});

test("a Part is a card that starts open, collapses with its body mounted, and shows its count", () => {
  render(
    <Part title="Volumes" testId="detail-volumes" icon={HardDrive} count={3}>
      <textarea aria-label="draft" defaultValue="kept" />
    </Part>,
  );
  const section = screen.getByTestId("detail-volumes");
  const toggle = screen.getByTestId("detail-section-toggle-volumes");
  expect(section.tagName).toBe("SECTION");
  expect(section.getAttribute("aria-labelledby")).toBe(toggle.id);
  expect(toggle.closest("h4")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toBe("Volumes3");
  const body = document.getElementById(
    toggle.getAttribute("aria-controls") ?? "",
  );
  expect(body?.hidden).toBe(false);
  fireEvent.change(screen.getByLabelText("draft"), {
    target: { value: "edited" },
  });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(body?.hidden).toBe(true);
  fireEvent.click(toggle);
  expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe(
    "edited",
  );
});

test("outside a drawer a Part saves nothing", () => {
  const backend = mockBackend({});
  render(<Part title="Rules">x</Part>);
  fireEvent.click(screen.getByTestId("detail-section-toggle-rules"));
  expect(backend.calls.filter((c) => c.cmd.startsWith("ui_state"))).toEqual([]);
});

test("inside a drawer the collapsed state is saved per kind and title, without the count", async () => {
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) =>
      a.key === "drawer.section.argoproj.io/applications.Sources" ? true : null,
    ui_state_set: () => null,
  });
  render(
    <DrawerKindContext.Provider
      value={{ group: "argoproj.io", plural: "applications" }}
    >
      <Part title="Sources (2)">a</Part>
      <Part title="Health">b</Part>
    </DrawerKindContext.Provider>,
  );
  await act(flush);
  expect(
    screen
      .getByTestId("detail-section-toggle-sources-2-")
      .getAttribute("aria-expanded"),
  ).toBe("false");
  vi.useFakeTimers();
  fireEvent.click(screen.getByTestId("detail-section-toggle-health"));
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(backend.callsTo("ui_state_set")).toContainEqual({
    key: "drawer.section.argoproj.io/applications.Health",
    value: true,
  });
});

test("a Part inside a Part is a sub-heading that keeps its test id", () => {
  render(
    <Part title="Spec">
      <Part title="Rules" testId="rules">
        r
      </Part>
    </Part>,
  );
  const inner = screen.getByTestId("rules");
  expect(within(inner).getByText("Rules").tagName).toBe("H5");
  expect(screen.queryByTestId("detail-section-toggle-rules")).toBeNull();
});

test("an ExpandRow starts closed and opens to its body", () => {
  render(
    <ExpandRow
      label="Labels"
      count={2}
      summary="app=web, tier=front"
      testId="detail-labels"
    >
      <p>body</p>
    </ExpandRow>,
  );
  const toggle = screen.getByTestId("detail-expand-labels");
  expect(screen.getByTestId("detail-labels").contains(toggle)).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toBe("Labels2app=web, tier=front");
  expect(screen.getByText("body").closest("[hidden]")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("body").closest("[hidden]")).toBeNull();
});

test("fact rows, stats, items and sub-rows", () => {
  render(
    <>
      <FactList>
        <FactRow label="Node" testId="fact-node">
          n1
        </FactRow>
      </FactList>
      <StatGrid
        stats={[
          {
            id: "ready",
            label: "Ready",
            value: "1/1",
            title: "Containers ready",
          },
        ]}
      />
      <ItemList>
        <Item testId="item-a" head={<span>a</span>}>
          <SubRow label="Image">nginx</SubRow>
        </Item>
      </ItemList>
    </>,
  );
  expect(screen.getByTestId("fact-node").textContent).toBe("Noden1");
  const stat = screen.getByTestId("detail-stat-ready");
  expect(stat.textContent).toBe("Ready1/1");
  expect(stat.getAttribute("title")).toBe("Containers ready");
  expect(screen.getByTestId("item-a").textContent).toBe("aImagenginx");
});

test("stats, item heads, chips and expand summaries each copy their value", async () => {
  render(
    <>
      <StatGrid
        stats={[{ id: "ready", label: "Ready", value: <strong>1/1</strong> }]}
      />
      <ItemList>
        <Item
          testId="item-web"
          head={
            <>
              <span>web</span>
              <span>Running</span>
            </>
          }
          copy={{ what: "container name", value: "web" }}
        />
      </ItemList>
      <Chips values={["app=web", "tier=front"]} />
      <ExpandRow label="Tolerations" count={2} summary="a=1:NoSchedule, b">
        <p>body</p>
      </ExpandRow>
    </>,
  );
  expect(await copyField("Ready")).toBe("1/1");
  expect(screen.getByTestId("copy-field-ready")).toBeTruthy();
  // An item copies its name, not the badges beside it.
  expect(await copyField("container name")).toBe("web");
  expect(await copyField("app=web")).toBe("app=web");
  expect(await copyField("tier=front")).toBe("tier=front");
  expect(await copyField("Tolerations")).toBe("a=1:NoSchedule, b");
  // The copy button sits beside the toggle: copying does not open the row.
  const toggle = screen.getByTestId("detail-expand-tolerations");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(
    toggle.contains(screen.getByRole("button", { name: /Tolerations$/ })),
  ).toBe(false);
  // After a copy the button says so, with Check in place of Copy.
  expect(
    screen
      .getByRole("button", { name: "Copied Tolerations" })
      .getAttribute("data-state"),
  ).toBe("done");
  // An item given nothing to copy has no button, and a chip's text is still the value.
  render(
    <ItemList>
      <Item testId="item-plain" head={<span>plain</span>} />
    </ItemList>,
  );
  expect(
    within(screen.getByTestId("item-plain")).queryByRole("button"),
  ).toBeNull();
  expect(screen.getAllByTestId("copy-chip")).toHaveLength(2);
});

/** Selects the text of `node`, as a drag over it would. */
function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

test("a toggle clicked at the end of a text selection in its row stays as it was", () => {
  render(
    <>
      <p>elsewhere</p>
      <ExpandRow label="Labels" count={1} summary="app=web">
        <p>labels body</p>
      </ExpandRow>
      <Part title="Summary">
        <p>summary body</p>
      </Part>
    </>,
  );
  const expand = screen.getByTestId("detail-expand-labels");
  select(screen.getByText("app=web"));
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  const card = screen.getByTestId("detail-section-toggle-summary");
  select(screen.getByText("summary body"));
  fireEvent.click(card);
  expect(card.getAttribute("aria-expanded")).toBe("true");
  // A selection somewhere else does not stop the click.
  select(screen.getByText("elsewhere"));
  fireEvent.click(expand);
  fireEvent.click(card);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(card.getAttribute("aria-expanded")).toBe("false");
  // Nor does a collapsed selection, which a plain click leaves.
  window.getSelection()?.collapse(screen.getByText("app=web"), 0);
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  window.getSelection()?.removeAllRanges();
});
