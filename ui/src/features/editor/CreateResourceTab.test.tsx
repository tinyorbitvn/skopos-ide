import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApplyResult } from "../../ipc/generated/ApplyResult";
import { resetDockForTest, useDock, writeDraft } from "../../stores/dock";
import { resetProposalsForTest, useProposals } from "../../stores/proposals";
import { kindSchema } from "../../test/apiDocs";
import { flush, mockBackend } from "../../test/ipc";
import { proposal } from "../../test/proposals";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import { resetApiDocsCacheForTest } from "./apiDocsCache";
import { resetApiDocsToggleForTest } from "./apiDocsToggle";
import { CreateResourceTab } from "./CreateResourceTab";
import { TEMPLATES } from "./templates/catalog";
import { CHECK_AT_ONCE_CHARS } from "./useYamlCheck";

vi.mock("./YamlDiff", () => ({
  YamlDiff: (p: { modified: string }) => (
    <pre data-testid="yaml-proposal-diff">{p.modified}</pre>
  ),
}));

vi.mock("./YamlEditor", async () => {
  const { useEffect } = await import("react");
  function FakeYamlEditor(props: {
    value: string;
    onChange(v: string): void;
    onCaret?(offset: number): void;
    readOnly?: boolean;
    testId?: string;
    replaceRequest?: { id: number; text: string } | null;
  }) {
    const { onChange, replaceRequest } = props;
    useEffect(() => {
      if (replaceRequest) onChange(replaceRequest.text);
    }, [replaceRequest?.id]);
    return (
      <>
        <textarea
          data-testid={props.testId}
          value={props.value}
          readOnly={props.readOnly}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <input
          data-testid="yaml-caret"
          onChange={(e) => props.onCaret?.(Number(e.target.value))}
        />
      </>
    );
  }

  return { YamlEditor: FakeYamlEditor };
});

const TAB = {
  id: "create-tab",
  kind: "create" as const,
  clusterId: "c1",
  title: "Create",
  dirty: false,
};

const DOCUMENT = "kind: ConfigMap\nmetadata:\n  name: app\n";

function backend(
  namespaces: unknown = null,
  apply: () => unknown = () => [] as ApplyResult[],
) {
  return mockBackend({
    ui_state_get: () => namespaces,
    ui_state_set: () => null,
    resource_apply: apply,
    chat_proposal_answer: () => null,
    api_schema: (args: { apiVersion: string; kind: string }) =>
      kindSchema({ apiVersion: args.apiVersion, kind: args.kind }),
  });
}

function show() {
  useDock.getState().open(TAB);
  return render(<CreateResourceTab tab={TAB} resources={[]} />);
}

function editor() {
  return screen.getByTestId<HTMLTextAreaElement>("yaml-editor");
}

function applyButton() {
  return screen.getByTestId<HTMLButtonElement>("create-apply");
}

function type(text: string) {
  fireEvent.change(editor(), { target: { value: text } });
}

function dirty() {
  return useDock.getState().tabs.find((t) => t.id === TAB.id)?.dirty;
}

/** Valid YAML lines that make a document longer than the editor checks as it is typed. */
function longData(): string {
  const lines: string[] = [];
  for (let size = 0; size <= CHECK_AT_ONCE_CHARS; ) {
    const line = `  key-${lines.length}: value\n`;
    lines.push(line);
    size += line.length;
  }
  return `data:\n${lines.join("")}`;
}

function pickTemplate(id: string) {
  fireEvent.click(screen.getByTestId("create-template"));
  fireEvent.click(screen.getByTestId(`menu-item-${id}`));
}

beforeEach(() => {
  resetProposalsForTest();
});

afterEach(() => {
  // Unmount before the resets, so no mounted panel asks for API docs again and fills
  // the cache the next test starts from.
  cleanup();
  resetDockForTest();
  resetApiDocsToggleForTest();
  resetApiDocsCacheForTest();
});

test("template fills the editor and leaves it clean", async () => {
  backend();
  show();
  expect(editor().value).toBe("");
  expect(applyButton().disabled).toBe(true);

  pickTemplate("deployment");
  await act(flush);

  const deployment = TEMPLATES.find((t) => t.id === "deployment");
  expect(editor().value).toBe(deployment?.yaml);
  expect(dirty()).toBe(false);
  expect(applyButton().disabled).toBe(false);
});

test("a template asks before replacing unsaved text", async () => {
  backend();
  show();
  type(DOCUMENT);
  expect(dirty()).toBe(true);

  pickTemplate("pod");
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await act(flush);
  expect(editor().value).toBe(DOCUMENT);

  pickTemplate("pod");
  const again = await screen.findByRole("dialog");
  fireEvent.click(within(again).getByRole("button", { name: "Replace" }));
  await act(flush);
  expect(editor().value).toBe(TEMPLATES.find((t) => t.id === "pod")?.yaml);
});

test("per-document results render with ok and failure", async () => {
  const results: ApplyResult[] = [
    {
      index: 0,
      kind: "ConfigMap",
      namespace: "default",
      name: "app",
      ok: true,
      message: "applied",
    },
    {
      index: 1,
      kind: "Widget",
      namespace: null,
      name: "w",
      ok: false,
      message: 'no matches for kind "Widget"',
    },
    {
      index: 2,
      kind: null,
      namespace: null,
      name: null,
      ok: false,
      message: "the document has no kind",
    },
  ];
  backend(null, () => results);
  show();
  type(`${DOCUMENT}---\nkind: Widget\n---\nname: x\n`);

  fireEvent.click(applyButton());
  await act(flush);

  const list = screen.getByTestId("apply-results");
  const ok = within(list).getByTestId("apply-result-0");
  expect(ok.textContent).toContain("ConfigMap");
  expect(ok.textContent).toContain("default/app");
  expect(ok.textContent).toContain("applied");
  expect(ok.dataset.ok).toBe("true");
  const failed = within(list).getByTestId("apply-result-1");
  expect(failed.textContent).toContain('no matches for kind "Widget"');
  expect(failed.dataset.ok).toBe("false");
  expect(within(list).getByTestId("apply-result-2").textContent).toContain(
    "Document 3",
  );

  // Something failed, so the text is still worth keeping.
  expect(editor().value).toContain("Widget");
  expect(dirty()).toBe(true);
});

test("when every document applies the tab is clean", async () => {
  backend(null, () => [
    {
      index: 0,
      kind: "ConfigMap",
      namespace: "default",
      name: "app",
      ok: true,
      message: "applied",
    },
  ]);
  show();
  type(DOCUMENT);
  expect(dirty()).toBe(true);

  fireEvent.click(applyButton());
  await act(flush);

  expect(dirty()).toBe(false);
});

test("the default namespace comes from the first selected namespace filter value", async () => {
  const calls = backend(["team-b", "team-a"]);
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(
    calls
      .callsTo("ui_state_get")
      .filter((args) => args.key === namespaceFilterKey("c1")),
  ).toEqual([{ key: namespaceFilterKey("c1") }]);
  expect(calls.callsTo("resource_apply")).toEqual([
    { clusterId: "c1", yaml: DOCUMENT, defaultNamespace: "team-b" },
  ]);
});

test.each([
  ["no saved filter", null],
  ["the All filter", []],
])("the default namespace is default with %s", async (_, saved) => {
  const calls = backend(saved);
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(calls.callsTo("resource_apply")[0].defaultNamespace).toBe("default");
});

test("the default namespace is default when the filter cannot be read", async () => {
  const calls = mockBackend({
    ui_state_get: () => {
      throw { code: "Internal", message: "no store", details: null };
    },
    resource_apply: () => [],
  });
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(calls.callsTo("resource_apply")[0].defaultNamespace).toBe("default");
});

test("invalid YAML blocks apply", async () => {
  const calls = backend();
  show();

  type("a: 1\nb: 2\n  c: 3\n");

  expect(screen.getByTestId("yaml-error").textContent).toMatch(/line 2/i);
  expect(applyButton().disabled).toBe(true);
  fireEvent.click(applyButton());
  await act(flush);
  expect(calls.callsTo("resource_apply")).toEqual([]);

  type(DOCUMENT);
  expect(screen.queryByTestId("yaml-error")).toBeNull();
  expect(applyButton().disabled).toBe(false);
});

test("long text is checked once the typing pauses, and cannot be applied before", async () => {
  const calls = backend();
  show();
  const long = `${DOCUMENT}${longData()}`;

  type(`${long}broken: [1\n`);
  expect(applyButton().disabled).toBe(true);
  expect(screen.queryByTestId("yaml-error")).toBeNull();
  fireEvent.click(applyButton());
  await waitFor(() => expect(screen.getByTestId("yaml-error")).toBeTruthy());
  expect(applyButton().disabled).toBe(true);

  type(long);
  expect(applyButton().disabled).toBe(true);
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  expect(screen.queryByTestId("yaml-error")).toBeNull();
  expect(calls.callsTo("resource_apply")).toEqual([]);
});

test("text with no documents has nothing to apply", () => {
  backend();
  show();
  type("# just a note\n");
  expect(applyButton().disabled).toBe(true);
  expect(screen.queryByTestId("yaml-error")).toBeNull();
});

test("a request that fails as a whole shows the message and keeps the text", async () => {
  backend(null, () => {
    throw { code: "Unreachable", message: "connection refused", details: null };
  });
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(screen.getByTestId("yaml-api-error").textContent).toContain(
    "connection refused",
  );
  expect(editor().value).toBe(DOCUMENT);
  expect(dirty()).toBe(true);
});

test("the editor is read-only while applying", async () => {
  let finish: (v: unknown) => void = () => {};
  backend(null, () => new Promise((resolve) => (finish = resolve)));
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);
  expect(editor().readOnly).toBe(true);

  await act(async () => {
    finish([]);
    await flush();
  });
  expect(editor().readOnly).toBe(false);
});

test("starts from a draft, unsaved, when another tab handed one over", () => {
  backend();
  useDock.getState().open(TAB);
  writeDraft(TAB.id, { text: DOCUMENT, baseline: "", results: [] });

  render(<CreateResourceTab tab={TAB} resources={[]} />);

  expect(editor().value).toBe(DOCUMENT);
  expect(dirty()).toBe(true);
});

test("text and results survive the tab leaving the screen and coming back", async () => {
  backend(null, () => [
    {
      index: 0,
      kind: "ConfigMap",
      namespace: "default",
      name: "app",
      ok: false,
      message: "denied",
    },
  ]);
  const view = show();
  type(DOCUMENT);
  fireEvent.click(applyButton());
  await act(flush);

  view.unmount();
  render(<CreateResourceTab tab={TAB} resources={[]} />);

  expect(editor().value).toBe(DOCUMENT);
  expect(screen.getByTestId("apply-result-0").textContent).toContain("denied");
});

const TWO =
  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: b\n";

function moveCaret(offset: number) {
  fireEvent.change(screen.getByTestId("yaml-caret"), {
    target: { value: String(offset) },
  });
}

async function shownKind(kind: string) {
  await waitFor(() =>
    expect(screen.getByTestId("api-docs-kind").textContent).toBe(kind),
  );
}

async function wait(ms: number) {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

test("the API docs follow the document that holds the caret (spec L15)", async () => {
  const calls = backend();
  show();
  expect(await screen.findByTestId("api-docs-no-kind")).toBeTruthy();

  type(TWO);
  await shownKind("ConfigMap");
  moveCaret(TWO.indexOf("---") + 4);
  await shownKind("Deployment");
  moveCaret(0);
  await shownKind("ConfigMap");

  expect(calls.callsTo("api_schema")).toEqual([
    { clusterId: "c1", apiVersion: "v1", kind: "ConfigMap" },
    { clusterId: "c1", apiVersion: "apps/v1", kind: "Deployment" },
  ]);
});

test("a document of only a comment or a bare --- has no kind (spec L15)", async () => {
  const calls = backend();
  show();
  const text = "apiVersion: v1\nkind: ConfigMap\n---\n# only a note\n";
  type(text);
  await shownKind("ConfigMap");

  moveCaret(text.length);
  expect(await screen.findByTestId("api-docs-no-kind")).toBeTruthy();

  type("---\n");
  moveCaret(0);
  await wait(400);
  expect(screen.getByTestId("api-docs-no-kind")).toBeTruthy();
  expect(calls.callsTo("api_schema")).toHaveLength(1);
});

test("text that does not parse keeps the kind shown last (spec L15)", async () => {
  const calls = backend();
  show();
  type("apiVersion: v1\nkind: ConfigMap\n");
  await shownKind("ConfigMap");

  type("apiVersion: v1\nkind: [\n");
  expect(screen.getByTestId("yaml-error")).toBeTruthy();
  await wait(400);

  expect(screen.getByTestId("api-docs-kind").textContent).toBe("ConfigMap");
  expect(calls.callsTo("api_schema")).toHaveLength(1);
});

test("Ask AI opens the bar with the create placeholder", async () => {
  backend();
  show();
  fireEvent.click(screen.getByTestId("yaml-ai"));
  expect(screen.getByTestId("yaml-ai").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(
    (screen.getByTestId("yaml-ai-input") as HTMLTextAreaElement).placeholder,
  ).toBe("Describe the objects to create");
});

test("a pending proposal shows its bar and diff, locks Apply, and Accept puts it in the editor", async () => {
  backend();
  show();
  act(() =>
    useProposals.getState().receive(
      "chat-1",
      proposal({
        tabId: TAB.id,
        yaml: "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n",
      }),
    ),
  );
  expect(screen.getByTestId("yaml-proposal-bar").textContent).toContain(
    "AI proposal",
  );
  expect(screen.getByTestId("yaml-proposal-diff").textContent).toContain(
    "kind: Namespace",
  );
  expect(
    (screen.getByTestId("create-apply") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId("create-template") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByTestId("yaml-proposal-accept"));
  expect(
    (screen.getByTestId("yaml-editor") as HTMLTextAreaElement).value,
  ).toContain("kind: Namespace");
  expect(screen.queryByTestId("yaml-proposal-bar")).toBeNull();
});

test("Reject drops the proposal and keeps the text", async () => {
  backend();
  show();
  type(DOCUMENT);
  act(() =>
    useProposals.getState().receive("chat-1", proposal({ tabId: TAB.id })),
  );
  fireEvent.click(screen.getByTestId("yaml-proposal-reject"));
  expect(screen.queryByTestId("yaml-proposal-bar")).toBeNull();
  expect(editor().value).toBe(DOCUMENT);
});

test("a draft made for AI opens with the bar", async () => {
  backend();
  // A draft is kept only for an open tab, as `openAiDraft` writes it.
  useDock.getState().open(TAB);
  writeDraft(TAB.id, { text: "", baseline: "", results: [], ai: true });
  show();
  expect(screen.getByTestId("yaml-ai-bar")).toBeTruthy();
});
