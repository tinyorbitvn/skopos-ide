import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { readDraft, resetDockForTest, useDock } from "../../stores/dock";
import { resetProposalsForTest, useProposals } from "../../stores/proposals";
import { CONFIG_MAP } from "../../test/apiDocs";
import { flush, mockBackend } from "../../test/ipc";
import { proposal } from "../../test/proposals";
import { setAgentsSupportedForTest } from "../agents/supported";
import { resetApiDocsCacheForTest } from "./apiDocsCache";
import { resetApiDocsToggleForTest } from "./apiDocsToggle";
import { EditResourceTab } from "./EditResourceTab";
import { CHECK_AT_ONCE_CHARS } from "./useYamlCheck";

vi.mock("./YamlDiff", () => ({
  YamlDiff: (p: { modified: string }) => (
    <pre data-testid="yaml-proposal-diff">{p.modified}</pre>
  ),
}));

vi.mock("./YamlEditor", () => ({
  YamlEditor: (props: {
    value: string;
    onChange(v: string): void;
    readOnly?: boolean;
    testId?: string;
  }) => (
    <textarea
      data-testid={props.testId}
      value={props.value}
      readOnly={props.readOnly}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

const CONFIG_MAPS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "configmaps",
  kind: "ConfigMap",
  namespaced: true,
};

const TAB = {
  id: "edit-1",
  kind: "edit" as const,
  clusterId: "c1",
  title: "ConfigMap app",
  resource: CONFIG_MAPS,
  namespace: "team-a",
  name: "app",
  dirty: false,
};

const YAML =
  "kind: ConfigMap\nmetadata:\n  name: app\n  resourceVersion: '1'\n";
const EDITED = `${YAML}data:\n  a: b\n`;

function failure(code: string, message: string) {
  return { code, message, details: null };
}

function backend(overrides: Record<string, (args: never) => unknown> = {}) {
  return mockBackend({
    resource_get_yaml: () => YAML,
    resource_replace: () => ({}),
    chat_proposal_answer: () => null,
    ui_state_get: () => null,
    ui_state_set: () => null,
    api_schema: () => CONFIG_MAP,
    ...overrides,
  });
}

async function show() {
  useDock.getState().open(TAB);
  const view = render(<EditResourceTab tab={TAB} resources={[]} />);
  await act(flush);
  return view;
}

function editor() {
  return screen.getByTestId<HTMLTextAreaElement>("yaml-editor");
}

function save() {
  return screen.getByTestId<HTMLButtonElement>("yaml-save");
}

function edit(text: string) {
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

beforeEach(() => {
  resetProposalsForTest();
  setAgentsSupportedForTest(true);
});

afterEach(() => {
  // Unmount before the resets, so no mounted panel asks for API docs again and fills
  // the cache the next test starts from.
  cleanup();
  resetDockForTest();
  resetApiDocsToggleForTest();
  resetApiDocsCacheForTest();
});

test("loads the YAML, is clean, and save is disabled until edited", async () => {
  const calls = backend();
  await show();

  expect(calls.callsTo("resource_get_yaml")).toEqual([
    {
      clusterId: "c1",
      resource: CONFIG_MAPS,
      namespace: "team-a",
      name: "app",
    },
  ]);
  expect(editor().value).toBe(YAML);
  expect(save().disabled).toBe(true);
  expect(dirty()).toBe(false);

  edit(EDITED);
  expect(save().disabled).toBe(false);
  expect(dirty()).toBe(true);

  edit(YAML);
  expect(save().disabled).toBe(true);
  expect(dirty()).toBe(false);
});

test("a cluster-scoped object is asked for without a namespace", async () => {
  const calls = backend();
  const tab = { ...TAB, namespace: undefined };
  useDock.getState().open(tab);
  render(<EditResourceTab tab={tab} resources={[]} />);
  await act(flush);

  expect(calls.callsTo("resource_get_yaml")[0].namespace).toBeNull();
});

test("invalid YAML blocks saving and shows the line", async () => {
  const calls = backend();
  await show();

  edit("a: 1\nb: 2\n  c: 3\n");

  expect(screen.getByTestId("yaml-error").textContent).toMatch(/line 2/i);
  expect(save().disabled).toBe(true);
  fireEvent.click(save());
  await act(flush);
  expect(calls.callsTo("resource_replace")).toEqual([]);

  edit(EDITED);
  expect(screen.queryByTestId("yaml-error")).toBeNull();
  expect(save().disabled).toBe(false);
});

test("long text is checked once the typing pauses, and cannot be saved before", async () => {
  const calls = backend();
  await show();
  const long = `${YAML}${longData()}`;

  edit(`${long}broken: [1\n`);
  expect(save().disabled).toBe(true);
  expect(screen.queryByTestId("yaml-error")).toBeNull();
  fireEvent.click(save());
  await waitFor(() => expect(screen.getByTestId("yaml-error")).toBeTruthy());
  expect(save().disabled).toBe(true);

  edit(long);
  expect(save().disabled).toBe(true);
  await waitFor(() => expect(save().disabled).toBe(false));
  expect(screen.queryByTestId("yaml-error")).toBeNull();
  expect(calls.callsTo("resource_replace")).toEqual([]);
});

test("more or fewer than one document blocks saving", async () => {
  const calls = backend();
  await show();

  edit(`${YAML}---\na: 1\n`);
  expect(screen.getByTestId("yaml-error").textContent).toMatch(/one YAML/);
  expect(save().disabled).toBe(true);

  edit("# nothing\n");
  expect(screen.getByTestId("yaml-error").textContent).toMatch(/one YAML/);
  expect(save().disabled).toBe(true);
  expect(calls.callsTo("resource_replace")).toEqual([]);
});

test("save calls resource_replace with force false and reloads", async () => {
  const reloaded = `${EDITED}# stored\n`;
  let stored = YAML;
  const calls = backend({
    resource_get_yaml: () => stored,
    resource_replace: () => {
      stored = reloaded;
      return {};
    },
  });
  await show();

  edit(EDITED);
  fireEvent.click(save());
  await act(flush);

  expect(calls.callsTo("resource_replace")).toEqual([
    {
      clusterId: "c1",
      resource: CONFIG_MAPS,
      namespace: "team-a",
      name: "app",
      yaml: EDITED,
      force: false,
    },
  ]);
  expect(calls.callsTo("resource_get_yaml")).toHaveLength(2);
  expect(editor().value).toBe(reloaded);
  expect(save().disabled).toBe(true);
  expect(dirty()).toBe(false);
});

test("the editor is read-only while saving, so no keystroke is lost", async () => {
  let finish: (v: unknown) => void = () => {};
  backend({
    resource_replace: () => new Promise((resolve) => (finish = resolve)),
  });
  await show();

  edit(EDITED);
  fireEvent.click(save());
  await act(flush);
  expect(editor().readOnly).toBe(true);

  await act(async () => {
    finish({});
    await flush();
  });
  expect(editor().readOnly).toBe(false);
});

test("a save that cannot reload says so and stays clean", async () => {
  let reads = 0;
  backend({
    resource_get_yaml: () => {
      reads += 1;
      if (reads > 1) throw failure("Unreachable", "connection refused");
      return YAML;
    },
  });
  await show();

  edit(EDITED);
  fireEvent.click(save());
  await act(flush);

  expect(screen.getByTestId("yaml-api-error").textContent).toContain(
    "connection refused",
  );
  expect(editor().value).toBe(EDITED);
  expect(dirty()).toBe(false);
});

test("a Conflict opens the dialog; Reload discards edits, Overwrite saves with force true", async () => {
  const fresh = `${YAML}# changed elsewhere\n`;
  let stored = YAML;
  const calls = backend({
    resource_get_yaml: () => stored,
    resource_replace: (args: { force: boolean; yaml: string }) => {
      if (!args.force)
        throw failure("Conflict", "the object has been modified");
      stored = `${args.yaml}# overwritten\n`;
      return {};
    },
  });
  await show();

  edit(EDITED);
  fireEvent.click(save());
  await screen.findByTestId("conflict-dialog");
  expect(screen.queryByTestId("yaml-api-error")).toBeNull();
  expect(editor().value).toBe(EDITED);

  // Reload discards the edits.
  stored = fresh;
  fireEvent.click(screen.getByTestId("conflict-reload"));
  await act(flush);
  expect(screen.queryByTestId("conflict-dialog")).toBeNull();
  expect(editor().value).toBe(fresh);
  expect(dirty()).toBe(false);
  expect(calls.callsTo("resource_replace")).toHaveLength(1);

  // Overwrite sends the edits with force.
  edit(EDITED);
  fireEvent.click(save());
  await screen.findByTestId("conflict-dialog");
  fireEvent.click(screen.getByTestId("conflict-overwrite"));
  await act(flush);

  expect(screen.queryByTestId("conflict-dialog")).toBeNull();
  const replaced = calls.callsTo("resource_replace");
  expect(replaced).toHaveLength(3);
  expect(replaced[2]).toMatchObject({ yaml: EDITED, force: true });
  expect(editor().value).toBe(`${EDITED}# overwritten\n`);
  expect(dirty()).toBe(false);
});

test("cancelling the conflict dialog keeps the edits and sends nothing", async () => {
  const calls = backend({
    resource_replace: () => {
      throw failure("Conflict", "the object has been modified");
    },
  });
  await show();

  edit(EDITED);
  fireEvent.click(save());
  await screen.findByTestId("conflict-dialog");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  await act(flush);

  expect(screen.queryByTestId("conflict-dialog")).toBeNull();
  expect(editor().value).toBe(EDITED);
  expect(dirty()).toBe(true);
  expect(calls.callsTo("resource_replace")).toHaveLength(1);
});

test("an API validation error shows verbatim and keeps the edits", async () => {
  const message =
    'ConfigMap "app" is invalid: metadata.name: Invalid value: must be lowercase';
  let fail = true;
  const calls = backend({
    resource_replace: () => {
      if (fail) throw failure("InvalidInput", message);
      return {};
    },
  });
  await show();

  edit(EDITED);
  fireEvent.click(save());
  await act(flush);

  expect(screen.getByTestId("yaml-api-error").textContent).toContain(message);
  expect(editor().value).toBe(EDITED);
  expect(dirty()).toBe(true);
  expect(save().disabled).toBe(false);
  expect(calls.callsTo("resource_get_yaml")).toHaveLength(1);

  // The message goes away once a save gets through.
  fail = false;
  fireEvent.click(save());
  await act(flush);
  expect(screen.queryByTestId("yaml-api-error")).toBeNull();
});

test("object deleted on server shows a notice and offers Create instead", async () => {
  backend({
    resource_replace: () => {
      throw failure("NotFound", 'configmaps "app" not found');
    },
  });
  await show();

  edit(`${YAML}data:\n  kept: yes\n`);
  fireEvent.click(save());
  await act(flush);

  expect(screen.getByTestId("yaml-deleted").textContent).toMatch(/deleted/i);
  expect(screen.queryByTestId("yaml-save")).toBeNull();
  expect(editor().value).toContain("kept: yes");

  fireEvent.click(screen.getByTestId("yaml-create-instead"));

  const { tabs, activeId } = useDock.getState();
  expect(tabs.map((t) => t.kind)).toEqual(["create"]);
  expect(activeId).toBe(tabs[0].id);
  expect(tabs[0].clusterId).toBe("c1");
  const draft = readDraft<{ text: string }>(tabs[0].id);
  expect(draft?.text).toContain("kept: yes");
  expect(draft?.text).not.toContain("resourceVersion");
});

test("opening an object that is already gone offers Create with a skeleton", async () => {
  backend({
    resource_get_yaml: () => {
      throw failure("NotFound", 'configmaps "app" not found');
    },
  });
  await show();

  expect(screen.getByTestId("yaml-deleted")).toBeTruthy();
  expect(screen.queryByTestId("yaml-editor")).toBeNull();

  fireEvent.click(screen.getByTestId("yaml-create-instead"));

  const { tabs } = useDock.getState();
  const text = readDraft<{ text: string }>(tabs[0].id)?.text ?? "";
  expect(text).toContain("apiVersion: v1");
  expect(text).toContain("kind: ConfigMap");
  expect(text).toContain("name: app");
  expect(text).toContain("namespace: team-a");
});

test("a failed load shows the message and can retry", async () => {
  let fail = true;
  backend({
    resource_get_yaml: () => {
      if (fail) throw failure("Forbidden", "configmaps is forbidden");
      return YAML;
    },
  });
  await show();

  expect(screen.getByRole("alert").textContent).toContain(
    "configmaps is forbidden",
  );
  expect(screen.queryByTestId("yaml-editor")).toBeNull();

  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(editor().value).toBe(YAML));
});

test("unsaved edits survive the tab leaving the screen and coming back", async () => {
  const calls = backend();
  const view = await show();

  edit(EDITED);
  view.unmount();
  render(<EditResourceTab tab={TAB} resources={[]} />);
  await act(flush);

  expect(editor().value).toBe(EDITED);
  expect(dirty()).toBe(true);
  expect(save().disabled).toBe(false);
  expect(calls.callsTo("resource_get_yaml")).toHaveLength(1);

  // Saving against the original version still notices a change on the server.
  fireEvent.click(save());
  await act(flush);
  expect(calls.callsTo("resource_replace")[0]).toMatchObject({
    yaml: EDITED,
    force: false,
  });
});

test("a clean tab that comes back reads the object again", async () => {
  const calls = backend();
  const view = await show();

  view.unmount();
  render(<EditResourceTab tab={TAB} resources={[]} />);
  await act(flush);

  expect(calls.callsTo("resource_get_yaml")).toHaveLength(2);
});

test("the API docs show the kind of the object it edits (spec L14)", async () => {
  const calls = backend();
  await show();

  expect((await screen.findByTestId("api-docs-kind")).textContent).toBe(
    "ConfigMap",
  );
  expect(calls.callsTo("api_schema")).toEqual([
    { clusterId: "c1", apiVersion: "v1", kind: "ConfigMap" },
  ]);
});

test("the API docs toggle hides the panel and keeps the editor and its text (spec L17)", async () => {
  const calls = backend();
  await show();
  await screen.findByTestId("api-docs");
  edit(EDITED);
  const toggle = screen.getByTestId("api-docs-toggle");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(toggle);

  expect(screen.queryByTestId("api-docs")).toBeNull();
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(editor().value).toBe(EDITED);
  expect(calls.callsTo("ui_state_set")).toEqual([
    { key: "editor.apiDocs", value: false },
  ]);
});

test("a cluster with no API docs shows the error beside the editor, which keeps the focus and its test ids (spec L33)", async () => {
  backend({
    api_schema: () => {
      throw failure(
        "NotFound",
        "This cluster does not publish OpenAPI v3, so API docs are not available.",
      );
    },
  });
  await show();
  editor().focus();

  const error = await screen.findByTestId("api-docs-error");

  expect(error.textContent).toContain(
    "This cluster does not publish OpenAPI v3",
  );
  expect(document.activeElement).toBe(editor());
  expect(screen.getByTestId("yaml-save")).toBeTruthy();
});

test("Ask AI opens the bar with the edit placeholder", async () => {
  backend();
  await show();
  fireEvent.click(screen.getByTestId("yaml-ai"));
  expect(
    screen.getByTestId<HTMLTextAreaElement>("yaml-ai-input").placeholder,
  ).toBe("Describe the change to ConfigMap app");
});

test("a pending proposal disables Save", async () => {
  backend();
  await show();
  edit(EDITED);
  expect(save().disabled).toBe(false);
  act(() =>
    useProposals
      .getState()
      .receive("chat-1", proposal({ tabId: TAB.id, mode: "edit" })),
  );
  expect(screen.getByTestId("yaml-proposal-bar")).toBeTruthy();
  expect(save().disabled).toBe(true);
});
