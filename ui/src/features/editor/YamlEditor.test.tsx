import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { flush } from "../../test/ipc";
import { YamlEditor } from "./YamlEditor";

const hintMock = vi.hoisted(() => ({ setHintSource: vi.fn() }));
vi.mock("./hintProviders", () => hintMock);

const state = vi.hoisted(() => ({
  editors: [] as FakeEditor[],
  fail: false,
}));

interface CaretEvent {
  position: { offset: number };
}

class FakeEditor {
  value: string;
  options: Record<string, unknown>;
  listener: (() => void) | null = null;
  caretListener: ((event: CaretEvent) => void) | null = null;
  disposed = false;
  modelDisposed = false;

  constructor(options: Record<string, unknown>) {
    this.value = String(options.value);
    this.options = options;
  }
  getValue() {
    return this.value;
  }
  setValue(next: string) {
    this.value = next;
    this.listener?.();
  }
  type(next: string) {
    this.value = next;
    this.listener?.();
  }
  pushUndoStop() {
    return true;
  }
  executeEdits(_: string, edits: { text: string }[]) {
    this.value = edits[0].text;
    this.listener?.();
    return true;
  }
  moveCaret(offset: number) {
    this.caretListener?.({ position: { offset } });
  }
  updateOptions(options: Record<string, unknown>) {
    this.options = { ...this.options, ...options };
  }
  onDidChangeModelContent(listener: () => void) {
    this.listener = listener;
    return { dispose: () => (this.listener = null) };
  }
  onDidChangeCursorPosition(listener: (event: CaretEvent) => void) {
    this.caretListener = listener;
    return { dispose: () => (this.caretListener = null) };
  }
  getModel() {
    return {
      uri: { toString: () => "inmemory://model/1" },
      getOffsetAt: (position: { offset: number }) => position.offset,
      getFullModelRange: () => ({}),
      dispose: () => (this.modelDisposed = true),
    };
  }
  dispose() {
    this.disposed = true;
  }
}

vi.mock("./monaco", () => ({
  get monaco() {
    if (state.fail) throw new Error("chunk failed");
    return {
      editor: {
        create: (_: HTMLElement, options: Record<string, unknown>) => {
          const editor = new FakeEditor(options);
          state.editors.push(editor);
          return editor;
        },
      },
    };
  },
  currentTheme: () => "skopos-dark",
}));

beforeEach(() => {
  state.editors.length = 0;
  state.fail = false;
  hintMock.setHintSource.mockReset();
});

async function mounted(value = "a: 1\n") {
  const onChange = vi.fn();
  const view = render(
    <YamlEditor value={value} onChange={onChange} testId="editor" />,
  );
  await act(flush);
  return { onChange, view, editor: state.editors[0] };
}

test("creates a YAML editor with the value and the test id", async () => {
  const { editor } = await mounted();

  expect(screen.getByTestId("editor")).toBeTruthy();
  expect(editor.options).toMatchObject({
    value: "a: 1\n",
    language: "yaml",
    automaticLayout: true,
    readOnly: false,
  });
});

test("typing reports the new text", async () => {
  const { editor, onChange } = await mounted();

  editor.type("b: 2\n");

  expect(onChange).toHaveBeenCalledWith("b: 2\n");
});

test("a new value from outside replaces the text without reporting a change", async () => {
  const { editor, onChange, view } = await mounted();

  view.rerender(
    <YamlEditor value={"c: 3\n"} onChange={onChange} testId="editor" />,
  );

  expect(editor.getValue()).toBe("c: 3\n");
  expect(onChange).not.toHaveBeenCalled();
});

test("readOnly follows the prop", async () => {
  const { editor, onChange, view } = await mounted();

  view.rerender(
    <YamlEditor
      value={"a: 1\n"}
      onChange={onChange}
      readOnly
      testId="editor"
    />,
  );

  expect(editor.options.readOnly).toBe(true);
});

test("going away disposes the editor and its model", async () => {
  const { editor, view } = await mounted();

  view.unmount();

  expect(editor.disposed).toBe(true);
  expect(editor.modelDisposed).toBe(true);
});

test("an editor that cannot load says so", async () => {
  state.fail = true;
  render(<YamlEditor value="" onChange={() => {}} />);
  await act(flush);

  expect(screen.getByRole("alert").textContent).toContain(
    "editor could not be loaded",
  );
});

test("moving the caret reports its offset in the text", async () => {
  const onCaret = vi.fn();
  render(<YamlEditor value={"a: 1\n"} onChange={() => {}} onCaret={onCaret} />);
  await act(flush);

  state.editors[0].moveCaret(3);

  expect(onCaret).toHaveBeenCalledWith(3);
});

test("going away stops reporting the caret", async () => {
  const { editor, view } = await mounted();

  view.unmount();

  expect(editor.caretListener).toBeNull();
});

test("turns word suggestions off and registers the hint source until unmount", async () => {
  const hints = { clusterId: "c1", fixedTarget: null, served: [] };
  const view = render(
    <YamlEditor value="a: 1\n" onChange={vi.fn()} hints={hints} />,
  );
  await act(flush);
  expect(state.editors[0].options).toMatchObject({
    wordBasedSuggestions: "off",
    quickSuggestions: { other: true, comments: false, strings: true },
  });
  expect(hintMock.setHintSource).toHaveBeenCalledWith(
    "inmemory://model/1",
    hints,
  );
  view.unmount();
  expect(hintMock.setHintSource).toHaveBeenLastCalledWith(
    "inmemory://model/1",
    null,
  );
});

test("a replace request becomes one undoable edit", async () => {
  const { editor, onChange, view } = await mounted("a: 1\n");
  const undoStops = vi.spyOn(editor, "pushUndoStop");
  view.rerender(
    <YamlEditor
      value="a: 1\n"
      onChange={onChange}
      testId="editor"
      replaceRequest={{ id: 1, text: "b: 2\n" }}
    />,
  );
  expect(onChange).toHaveBeenCalledWith("b: 2\n");
  expect(undoStops).toHaveBeenCalledTimes(2);
});
