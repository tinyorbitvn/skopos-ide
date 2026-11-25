import { expect, test } from "vitest";
import { yamlContextAt } from "./yamlPath";

/** The context at the last `|` in `marked`, which is removed. Block scalars may hold an earlier `|`. */
function at(marked: string) {
  const offset = marked.lastIndexOf("|");
  return yamlContextAt(
    marked.slice(0, offset) + marked.slice(offset + 1),
    offset,
  );
}

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: main
          image: nginx
`;

test("a top-level key, with the document's kind", () => {
  const offset = DEPLOYMENT.indexOf("spec:") + 2;
  expect(yamlContextAt(DEPLOYMENT, offset)).toEqual({
    apiVersion: "apps/v1",
    kind: "Deployment",
    at: {
      at: "key",
      path: [],
      key: "spec",
      start: DEPLOYMENT.indexOf("spec:"),
      end: DEPLOYMENT.indexOf("spec:") + 4,
    },
  });
});

test("a key in a list of maps carries the item step", () => {
  const offset = DEPLOYMENT.indexOf("image") + 1;
  expect(yamlContextAt(DEPLOYMENT, offset).at).toMatchObject({
    at: "key",
    path: [
      { key: "spec" },
      { key: "template" },
      { key: "spec" },
      { key: "containers" },
      { item: true },
    ],
    key: "image",
  });
});

test("a list at the same indent as its key", () => {
  expect(
    at("spec:\n  containers:\n  - name: a\n    ima|ge: b\n").at,
  ).toMatchObject({
    at: "key",
    path: [{ key: "spec" }, { key: "containers" }, { item: true }],
    key: "image",
  });
});

test("a value after the colon", () => {
  expect(at("spec:\n  type: Node|\n").at).toEqual({
    at: "value",
    path: [{ key: "spec" }],
    key: "type",
    partial: "Node",
    start: "spec:\n  type: ".length,
  });
});

test("a partly typed key, with the keys already at that level", () => {
  expect(at("spec:\n  replicas: 2\n  sel|\n  template: {}\n").at).toEqual({
    at: "newKey",
    path: [{ key: "spec" }],
    partial: "sel",
    start: "spec:\n  replicas: 2\n  ".length,
    siblings: ["replicas", "template"],
  });
});

test("an empty line takes its level from the caret's column", () => {
  expect(at("metadata:\n  name: a\n  |\n").at).toMatchObject({
    at: "newKey",
    path: [{ key: "metadata" }],
    partial: "",
    siblings: ["name"],
  });
  expect(at("metadata:\n  name: a\n|\n").at).toMatchObject({
    at: "newKey",
    path: [],
    siblings: ["metadata"],
  });
});

test("after a dash, a new key goes into the item", () => {
  expect(at("spec:\n  containers:\n    - |\n").at).toMatchObject({
    at: "newKey",
    path: [{ key: "spec" }, { key: "containers" }, { item: true }],
    partial: "",
    siblings: [],
  });
  expect(at("containers:\n- na|\n  image: x\n").at).toMatchObject({
    at: "newKey",
    path: [{ key: "containers" }, { item: true }],
    partial: "na",
    siblings: ["image"],
  });
});

test("keys under a map of objects", () => {
  expect(at("data:\n  one:\n    fi|eld: x\n").at).toMatchObject({
    at: "key",
    path: [{ key: "data" }, { key: "one" }],
    key: "field",
  });
});

test("only the offset's document counts", () => {
  const text =
    "apiVersion: v1\nkind: Pod\n---\napiVersion: v1\nkind: Service\nspec:\n  ty|\n";
  const result = at(text);
  expect(result.kind).toBe("Service");
  expect(result.at).toMatchObject({
    at: "newKey",
    path: [{ key: "spec" }],
    siblings: [],
  });
});

test("quoted keys and quoted kinds", () => {
  const result = at(
    "apiVersion: \"v1\"\nkind: 'ConfigMap'\ndata:\n  \"a.b\": x\n  'c|': y\n",
  );
  expect(result.kind).toBe("ConfigMap");
  expect(result.apiVersion).toBe("v1");
  expect(result.at).toMatchObject({
    at: "key",
    path: [{ key: "data" }],
    key: "c",
  });
});

test("comments, block scalars and flow style give nothing", () => {
  expect(at("# a comm|ent\n").at).toEqual({ at: "none" });
  expect(at("spec:\n  replicas: 2 # tw|o\n").at).toEqual({ at: "none" });
  expect(at("data:\n  script: |\n    echo hi|\n").at).toEqual({ at: "none" });
  expect(at("spec: {replicas: 2, sel|}\n").at).toEqual({ at: "none" });
});

test("keys after a block scalar still have their path", () => {
  expect(
    at("data:\n  script: |\n    echo: hi\n  ot|her: x\n").at,
  ).toMatchObject({ at: "key", path: [{ key: "data" }], key: "other" });
});

test("no kind yet", () => {
  expect(at("apiVersion: v1\nme|\n")).toEqual({
    apiVersion: "v1",
    kind: null,
    at: {
      at: "newKey",
      path: [],
      partial: "me",
      start: 15,
      siblings: ["apiVersion"],
    },
  });
});

test("text that is not a key name gives nothing", () => {
  expect(at('spec:\n  "unterminated|\n').at).toEqual({ at: "none" });
  expect(at("spec:\n  ports: [80|\n").at).toEqual({ at: "none" });
});
