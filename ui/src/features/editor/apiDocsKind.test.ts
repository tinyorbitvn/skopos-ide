import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  editTarget,
  KIND_DELAY_MS,
  kindAt,
  useCreateTarget,
} from "./apiDocsKind";

const CONFIG_MAP_DOC =
  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n";
const DEPLOYMENT_DOC =
  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: b\n";
const TWO = `${CONFIG_MAP_DOC}---\n${DEPLOYMENT_DOC}`;
/** Where the second document starts: its `---`. */
const SECOND = TWO.indexOf("---");
const NOTE_AFTER = `${CONFIG_MAP_DOC}---\n# only a note\n`;

afterEach(() => vi.useRealTimers());

test("an edit tab's kind comes from its resource (spec L14)", () => {
  expect(
    editTarget({
      group: "",
      version: "v1",
      plural: "configmaps",
      kind: "ConfigMap",
      namespaced: true,
    }),
  ).toEqual({ apiVersion: "v1", kind: "ConfigMap" });
  expect(
    editTarget({
      group: "apps",
      version: "v1",
      plural: "deployments",
      kind: "Deployment",
      namespaced: true,
    }),
  ).toEqual({ apiVersion: "apps/v1", kind: "Deployment" });
});

test.each([
  ["the start", 0, "v1", "ConfigMap"],
  ["the end of the first document", SECOND - 1, "v1", "ConfigMap"],
  ["the --- of the second", SECOND, "apps/v1", "Deployment"],
  ["the end", TWO.length, "apps/v1", "Deployment"],
])(
  "the caret at %s picks that document (spec L15)",
  (_, caret, apiVersion, kind) => {
    expect(kindAt(TWO, caret)).toEqual({ apiVersion, kind });
  },
);

test.each([
  ["empty text", "", 0],
  ["only a comment", "# a note\n", 0],
  ["a bare ---", "---\n", 0],
  ["two bare ---", "---\n---\n", 5],
  ["a document with no kind", "apiVersion: v1\nmetadata: {}\n", 0],
  ["a document with no apiVersion", "kind: ConfigMap\n", 0],
  ["a kind that is not text", "apiVersion: v1\nkind: 5\n", 0],
  ["a blank kind", 'apiVersion: v1\nkind: " "\n', 0],
  ["a list", "- apiVersion: v1\n  kind: ConfigMap\n", 0],
  ["the comment after a ---", NOTE_AFTER, NOTE_AFTER.length],
])("%s has no kind (spec L15)", (_, text, caret) => {
  expect(kindAt(text, caret)).toBeNull();
});

test.each([
  ["a bad indent", "a: 1\nb: 2\n  c: 3\n"],
  ["an open flow", "apiVersion: v1\nkind: [\n"],
])("text with %s does not parse", (_, text) => {
  expect(kindAt(text, 0)).toBe("unparsed");
});

function created(text: string, caret: number) {
  return renderHook(
    (props: { text: string; caret: number }) =>
      useCreateTarget(props.text, props.caret),
    { initialProps: { text, caret } },
  );
}

test("a create tab reads the kind at once, then 300 ms after the text or the caret last changed (spec L15)", () => {
  vi.useFakeTimers();
  const { result, rerender } = created(TWO, 0);
  expect(result.current).toEqual({ apiVersion: "v1", kind: "ConfigMap" });

  rerender({ text: TWO, caret: TWO.length });
  act(() => {
    vi.advanceTimersByTime(KIND_DELAY_MS - 1);
  });
  expect(result.current?.kind).toBe("ConfigMap");
  // Another move starts the wait again.
  rerender({ text: TWO, caret: TWO.length - 1 });
  act(() => {
    vi.advanceTimersByTime(KIND_DELAY_MS - 1);
  });
  expect(result.current?.kind).toBe("ConfigMap");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current).toEqual({ apiVersion: "apps/v1", kind: "Deployment" });
});

test("text that does not parse keeps the kind found last, and a document with no kind clears it (spec L15)", () => {
  vi.useFakeTimers();
  const { result, rerender } = created(CONFIG_MAP_DOC, 0);

  rerender({ text: "apiVersion: v1\nkind: [\n", caret: 0 });
  act(() => {
    vi.advanceTimersByTime(KIND_DELAY_MS);
  });
  expect(result.current?.kind).toBe("ConfigMap");

  rerender({ text: "---\n", caret: 0 });
  act(() => {
    vi.advanceTimersByTime(KIND_DELAY_MS);
  });
  expect(result.current).toBeNull();
});

test("the same kind found again is the same object, so nothing asks again", () => {
  vi.useFakeTimers();
  const { result, rerender } = created(CONFIG_MAP_DOC, 0);
  const first = result.current;

  rerender({ text: `${CONFIG_MAP_DOC}data: {}\n`, caret: 3 });
  act(() => {
    vi.advanceTimersByTime(KIND_DELAY_MS);
  });

  expect(result.current).toBe(first);
});
