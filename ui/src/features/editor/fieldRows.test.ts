import { expect, test } from "vitest";
import { DEPLOYMENT, GADGET } from "../../test/apiDocs";
import {
  fieldsLabel,
  indexFields,
  pathSuffix,
  searchFields,
  type TreeRow,
  treeKey,
  visibleRows,
  withPath,
} from "./fieldRows";

const deployment = indexFields(DEPLOYMENT.fields);
const CONTAINERS = "spec.template.spec.containers[]";

function paths(rows: TreeRow[]): string[] {
  return rows.map((row) => row.node.path);
}

test.each([
  ["string", ""],
  ["IntOrString", ""],
  ["[]Container", "[]"],
  ["map[string]string", "{}"],
  ["[][]Cell", "[][]"],
  ["map[string][]string", "{}[]"],
  ["[]map[string]object", "[]{}"],
])("the type %s adds %j to the path (spec L22)", (typeLabel, suffix) => {
  expect(pathSuffix(typeLabel)).toBe(suffix);
});

test("paths join the names with dots, with [] after arrays and {} after maps (spec L22)", () => {
  expect(deployment.all.map((node) => node.path)).toEqual([
    "apiVersion",
    "kind",
    "metadata",
    "metadata.labels{}",
    "metadata.name",
    "spec",
    "spec.replicas",
    "spec.selector",
    "spec.selector.matchLabels{}",
    "spec.template",
    "spec.template.spec",
    CONTAINERS,
    `${CONTAINERS}.image`,
    `${CONTAINERS}.imagePullPolicy`,
    `${CONTAINERS}.name`,
    `${CONTAINERS}.ports[]`,
    `${CONTAINERS}.ports[].containerPort`,
  ]);
  expect(indexFields(GADGET.fields).all.map((node) => node.path)).toEqual([
    "spec",
    "spec.matrix[][]",
    "spec.matrix[][].value",
    "spec.parts{}",
    "spec.parts{}.size",
    "spec.self",
  ]);
});

test("levels count from 1 at the top (spec L21)", () => {
  const level = (path: string) =>
    deployment.all.find((node) => node.path === path)?.level;
  expect(level("spec")).toBe(1);
  expect(level("spec.template")).toBe(2);
  expect(level(`${CONTAINERS}.ports[].containerPort`)).toBe(6);
  expect(deployment.roots.map((node) => node.path)).toEqual([
    "apiVersion",
    "kind",
    "metadata",
    "spec",
  ]);
});

test("the count reads 1 field or n fields (spec L20)", () => {
  expect([fieldsLabel(0), fieldsLabel(1), fieldsLabel(17)]).toEqual([
    "0 fields",
    "1 field",
    "17 fields",
  ]);
});

test("at first only the top-level fields show, collapsed (spec L21)", () => {
  const rows = visibleRows(deployment, new Set(), null);
  expect(paths(rows)).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  expect(rows.map((row) => row.expandable)).toEqual([false, false, true, true]);
  expect(rows.some((row) => row.expanded)).toBe(false);
});

test("an expanded field shows its children under it", () => {
  const rows = visibleRows(deployment, new Set(["spec"]), null);
  expect(paths(rows)).toEqual([
    "apiVersion",
    "kind",
    "metadata",
    "spec",
    "spec.replicas",
    "spec.selector",
    "spec.template",
  ]);
  expect(rows[3].expanded).toBe(true);
});

test("a search matches names, ignoring case and the spaces around it, and opens each ancestor (spec L20)", () => {
  const search = searchFields(deployment, " IMAGE ");
  if (!search) throw new Error("a query is a search");
  expect(search.matches).toEqual(
    new Set([`${CONTAINERS}.image`, `${CONTAINERS}.imagePullPolicy`]),
  );
  expect(search.expanded).toEqual(
    new Set(["spec", "spec.template", "spec.template.spec", CONTAINERS]),
  );
  expect(paths(visibleRows(deployment, search.expanded, search))).toEqual([
    "spec",
    "spec.template",
    "spec.template.spec",
    CONTAINERS,
    `${CONTAINERS}.image`,
    `${CONTAINERS}.imagePullPolicy`,
  ]);
});

test("a blank query is no search", () => {
  expect(searchFields(deployment, "   ")).toBeNull();
});

test.each([".", "$", "(", "[]", "*", "\\", "a+"])(
  "the search %s is plain text and matches nothing here (spec L20)",
  (query) => {
    expect(searchFields(deployment, query)?.matches.size).toBe(0);
  },
);

test("a field the user opens during a search shows all its children", () => {
  const search = searchFields(deployment, "containers");
  if (!search) throw new Error("a query is a search");
  const opened = withPath(search.expanded, CONTAINERS, true);
  expect(paths(visibleRows(deployment, opened, search))).toEqual([
    "spec",
    "spec.template",
    "spec.template.spec",
    CONTAINERS,
    `${CONTAINERS}.image`,
    `${CONTAINERS}.imagePullPolicy`,
    `${CONTAINERS}.name`,
    `${CONTAINERS}.ports[]`,
  ]);
});

test("keys move through the visible rows and open and close fields (spec L23)", () => {
  let expanded: ReadonlySet<string> = new Set();
  function press(key: string, focus: string | null): string {
    const next = treeKey(
      key,
      visibleRows(deployment, expanded, null),
      focus,
      expanded,
    );
    if (!next) throw new Error(`${key} did nothing`);
    expanded = next.expanded;
    return next.focus;
  }

  expect(press("ArrowDown", null)).toBe("kind");
  expect(press("End", "kind")).toBe("spec");
  expect(press("ArrowRight", "spec")).toBe("spec");
  expect(expanded.has("spec")).toBe(true);
  expect(press("ArrowRight", "spec")).toBe("spec.replicas");
  expect(press("ArrowDown", "spec.replicas")).toBe("spec.selector");
  expect(press("ArrowLeft", "spec.selector")).toBe("spec");
  expect(press("ArrowLeft", "spec")).toBe("spec");
  expect(expanded.has("spec")).toBe(false);
  expect(press("ArrowUp", "spec")).toBe("metadata");
  expect(press("Home", "metadata")).toBe("apiVersion");
  expect(press("ArrowUp", "apiVersion")).toBe("apiVersion");
  expect(press("ArrowRight", "apiVersion")).toBe("apiVersion");
  expect(press("ArrowLeft", "apiVersion")).toBe("apiVersion");
  expect(
    treeKey(
      "a",
      visibleRows(deployment, expanded, null),
      "apiVersion",
      expanded,
    ),
  ).toBeNull();
  expect(treeKey("ArrowDown", [], null, expanded)).toBeNull();
});

test("withPath gives a new set and leaves the old one", () => {
  const before: ReadonlySet<string> = new Set(["a"]);
  expect(withPath(before, "b", true)).toEqual(new Set(["a", "b"]));
  expect(withPath(before, "a", false)).toEqual(new Set());
  expect(before).toEqual(new Set(["a"]));
});
