import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CONFIG_MAP,
  DEPLOYMENT,
  GADGET,
  kindSchema,
  schemaField,
} from "../../test/apiDocs";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { ApiDocsPanel } from "./ApiDocsPanel";
import { resetApiDocsCacheForTest } from "./apiDocsCache";
import type { ApiDocsTarget } from "./apiDocsKind";

const APPS: ApiDocsTarget = { apiVersion: "apps/v1", kind: "Deployment" };
const CONTAINERS = "spec.template.spec.containers[]";
const IMAGE = `${CONTAINERS}.image`;
const PULL_POLICY = `${CONTAINERS}.imagePullPolicy`;

beforeEach(() => mockElementSize());

afterEach(() => {
  vi.restoreAllMocks();
  resetApiDocsCacheForTest();
});

/** Shows the panel for `target`, with `api_schema` answering `answer`. */
async function show(
  answer: (args: { kind: string }) => unknown = () => DEPLOYMENT,
  target: ApiDocsTarget | null = APPS,
) {
  const calls = mockBackend({ api_schema: answer });
  const view = render(<ApiDocsPanel clusterId="c1" target={target} />);
  await act(flush);
  return { calls, view };
}

function byId(id: string) {
  return screen.getByTestId(id);
}

function field(path: string) {
  return screen.getByTestId(`api-docs-field-${path}`);
}

function rowPaths() {
  return screen.queryAllByRole("treeitem").map((row) => row.dataset.path);
}

function search(text: string) {
  fireEvent.change(byId("api-docs-search"), { target: { value: text } });
}

/** Clicks the chevron of the row at `path`. */
function chevron(path: string) {
  fireEvent.click(within(field(path)).getByRole("button"));
}

function facts() {
  return within(byId("api-docs-facts"))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

test("with no kind it asks nothing and says what to add (spec L25)", async () => {
  const { calls } = await show(undefined, null);

  expect(byId("api-docs-no-kind").textContent).toBe(
    "Add apiVersion and kind to see their fields.",
  );
  expect(calls.callsTo("api_schema")).toEqual([]);
});

test("while the docs load it shows a spinner (spec L25)", async () => {
  await show(() => new Promise(() => {}));

  expect(
    within(byId("api-docs-loading")).getByRole("status", {
      name: "Loading API docs",
    }),
  ).toBeTruthy();
});

test("an error shows its message, and Retry asks again (spec L16, L25)", async () => {
  let fail = true;
  const { calls } = await show(() => {
    if (fail) {
      throw {
        code: "NotFound",
        message:
          "This cluster does not publish OpenAPI v3, so API docs are not available.",
        details: "HTTP 404",
      };
    }
    return DEPLOYMENT;
  });
  const error = byId("api-docs-error");
  expect(error.textContent).toContain("API docs are not available");
  expect(error.textContent).toContain(
    "This cluster does not publish OpenAPI v3, so API docs are not available.",
  );

  fail = false;
  fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
  await act(flush);

  expect(byId("api-docs-kind").textContent).toBe("Deployment");
  expect(calls.callsTo("api_schema")).toHaveLength(2);
});

test("an error takes no focus (spec L33)", async () => {
  await show(() => {
    throw {
      code: "Forbidden",
      message: "You may not read the cluster's API docs (/openapi/v3).",
      details: "HTTP 403",
    };
  });

  expect(byId("api-docs-error")).toBeTruthy();
  expect(document.activeElement).toBe(document.body);
});

test("the header shows the kind, its apiVersion and its description (spec L19)", async () => {
  await show();

  expect(byId("api-docs-kind").textContent).toBe("Deployment");
  expect(byId("api-docs-version").textContent).toBe("apps/v1");
  const description = byId("api-docs-kind-description");
  expect(description.textContent).toBe(DEPLOYMENT.description);
  expect(description.title).toBe(DEPLOYMENT.description);
  expect(screen.queryByTestId("api-docs-truncated")).toBeNull();
});

test("a cut-short tree says so (spec L19)", async () => {
  await show(() => ({ ...DEPLOYMENT, truncated: true }));

  expect(byId("api-docs-truncated").textContent).toBe(
    "Only the first 20,000 fields are shown.",
  );
});

test("at first the top-level fields show, collapsed, and the status counts every field (spec L20, L21)", async () => {
  await show();

  expect(screen.getByRole("tree", { name: "Deployment fields" })).toBe(
    byId("api-docs-tree"),
  );
  expect(rowPaths()).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  expect(field("spec").getAttribute("aria-expanded")).toBe("false");
  expect(field("apiVersion").hasAttribute("aria-expanded")).toBe(false);
  expect(field("spec").getAttribute("aria-level")).toBe("1");
  const hits = byId("api-docs-hits");
  expect([hits.getAttribute("role"), hits.textContent]).toEqual([
    "status",
    "17 fields",
  ]);
});

test("a row shows a chevron, its name, a required mark and its type (spec L21)", async () => {
  await show();
  expect(
    within(field("spec")).getByRole("button").getAttribute("aria-label"),
  ).toBe("Expand spec");

  chevron("spec");

  expect(field("spec").getAttribute("aria-expanded")).toBe("true");
  expect(
    within(field("spec")).getByRole("button").getAttribute("aria-label"),
  ).toBe("Collapse spec");
  // The chevron opens the field without selecting it.
  expect(field("spec").getAttribute("aria-selected")).toBe("false");
  expect(rowPaths()).toEqual([
    "apiVersion",
    "kind",
    "metadata",
    "spec",
    "spec.replicas",
    "spec.selector",
    "spec.template",
  ]);
  const selector = field("spec.selector");
  expect(selector.getAttribute("aria-level")).toBe("2");
  expect(within(selector).getByTitle("Required").textContent).toBe("*");
  expect(selector.textContent).toBe("selector*LabelSelector");
  expect(within(field("spec.replicas")).queryByTitle("Required")).toBeNull();
});

test("a recursive field says so and does not open (spec L21)", async () => {
  await show(() => GADGET, {
    apiVersion: "gizmos.example.com/v1",
    kind: "Gadget",
  });

  chevron("spec");

  expect(field("spec.self").textContent).toBe("selfGadget (recursive)");
  expect(within(field("spec.self")).queryByRole("button")).toBeNull();
});

test("a search shows the matches with their ancestors open, and counts them (spec L20)", async () => {
  await show();

  search("image");
  expect(rowPaths()).toEqual([
    "spec",
    "spec.template",
    "spec.template.spec",
    CONTAINERS,
    IMAGE,
    PULL_POLICY,
  ]);
  expect(byId("api-docs-hits").textContent).toBe("2 fields");

  search("replicas");
  expect(byId("api-docs-hits").textContent).toBe("1 field");
});

test("clearing the search brings back what was open before it (spec L20)", async () => {
  await show();
  chevron("metadata");

  search("image");
  expect(rowPaths()).not.toContain("metadata");
  search("");

  expect(rowPaths()).toEqual([
    "apiVersion",
    "kind",
    "metadata",
    "metadata.labels{}",
    "metadata.name",
    "spec",
  ]);
  expect(byId("api-docs-hits").textContent).toBe("17 fields");
});

test.each([".", "$", "(", "[]", "*", "\\", "a+"])(
  "the query %s is plain text (spec L20)",
  async (query) => {
    await show();

    search(query);

    expect(byId("api-docs-empty").textContent).toBe(
      `No field is named like "${query}".`,
    );
    expect(screen.queryByTestId("api-docs-tree")).toBeNull();
    expect(byId("api-docs-hits").textContent).toBe("0 fields");
  },
);

test("keys move the selection and open and close fields, with one tab stop (spec L23)", async () => {
  await show();
  expect([field("apiVersion").tabIndex, field("kind").tabIndex]).toEqual([
    0, -1,
  ]);
  field("apiVersion").focus();
  const press = (key: string) =>
    fireEvent.keyDown(document.activeElement as Element, { key });

  press("ArrowDown");
  expect(document.activeElement).toBe(field("kind"));
  expect(field("kind").getAttribute("aria-selected")).toBe("true");
  expect([field("apiVersion").tabIndex, field("kind").tabIndex]).toEqual([
    -1, 0,
  ]);

  press("End");
  expect(document.activeElement).toBe(field("spec"));
  press("ArrowRight");
  expect(field("spec").getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(field("spec"));
  press("ArrowRight");
  expect(document.activeElement).toBe(field("spec.replicas"));
  press("ArrowLeft");
  expect(document.activeElement).toBe(field("spec"));
  press("ArrowLeft");
  expect(field("spec").getAttribute("aria-expanded")).toBe("false");
  press("Home");
  expect(document.activeElement).toBe(field("apiVersion"));
  expect(byId("api-docs-path").textContent).toBe("apiVersion");
});

test("clicking a field selects it and shows its details (spec L24)", async () => {
  await show();
  search("image");

  fireEvent.click(field(PULL_POLICY));
  expect(byId("api-docs-path").textContent).toBe(PULL_POLICY);
  expect(facts()).toEqual([
    "string · Field of Container",
    "One of: Always, IfNotPresent, Never",
  ]);

  fireEvent.click(field(IMAGE));
  expect(field(IMAGE).getAttribute("aria-selected")).toBe("true");
  expect(byId("api-docs-description").textContent).toBe(
    "Container image name.\nMore info: https://example.com/docs/images",
  );
});

test("the details show required, the format and the default (spec L24)", async () => {
  await show();
  chevron("spec");

  fireEvent.click(field("spec.replicas"));
  expect(facts()).toEqual([
    "integer · Field of DeploymentSpec",
    "Format: int32",
    "Default: 1",
  ]);

  fireEvent.click(field("spec.selector"));
  expect(facts()).toEqual([
    "LabelSelector · required · Field of DeploymentSpec",
  ]);
});

test("with nothing selected the details show the kind's description (spec L24)", async () => {
  await show();

  expect(
    within(byId("api-docs-detail")).getByTestId("api-docs-description")
      .textContent,
  ).toBe(DEPLOYMENT.description);
  expect(screen.queryByTestId("api-docs-path")).toBeNull();
});

test("another kind keeps the search text and drops the selection (spec L26)", async () => {
  const { view } = await show((args) =>
    args.kind === "Deployment" ? DEPLOYMENT : CONFIG_MAP,
  );
  search("name");
  fireEvent.click(field("metadata.name"));
  expect(byId("api-docs-path").textContent).toBe("metadata.name");

  view.rerender(
    <ApiDocsPanel
      clusterId="c1"
      target={{ apiVersion: "v1", kind: "ConfigMap" }}
    />,
  );
  await act(flush);

  expect(byId("api-docs-kind").textContent).toBe("ConfigMap");
  expect(screen.getByTestId<HTMLInputElement>("api-docs-search").value).toBe(
    "name",
  );
  expect(byId("api-docs-hits").textContent).toBe("1 field");
  expect(screen.queryByTestId("api-docs-path")).toBeNull();
});

test("only the rows in view are drawn (spec L21)", async () => {
  const wide = kindSchema({
    kind: "Wide",
    fields: Array.from({ length: 500 }, (_, n) =>
      schemaField({ name: `field${String(n).padStart(3, "0")}` }),
    ),
  });
  await show(() => wide, { apiVersion: "v1", kind: "Wide" });

  expect(byId("api-docs-hits").textContent).toBe("500 fields");
  const drawn = rowPaths().length;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(100);
});
