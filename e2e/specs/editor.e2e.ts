import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  closeDockTabs,
  dialogButton,
  dockTabTitles,
  editorContaining,
  editorText,
  gone,
  inDockPanel,
  newInDock,
  openCluster,
  openResource,
  pointerClick,
  resourceRowMenu,
  rowId,
  searchResources,
  setEditorText,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-e2e";

async function createConfigMap(name: string, value: string): Promise<void> {
  await kubectl([
    "-n",
    NS,
    "create",
    "configmap",
    name,
    `--from-literal=key=${value}`,
  ]);
}

async function storedValue(name: string): Promise<string> {
  return kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    name,
    "-o",
    "jsonpath={.data.key}",
  ]);
}

async function resourceVersion(name: string): Promise<string> {
  return kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    name,
    "-o",
    "jsonpath={.metadata.resourceVersion}",
  ]);
}

async function changeOnServer(name: string, value: string): Promise<void> {
  await kubectl([
    "-n",
    NS,
    "patch",
    "configmap",
    name,
    "--type=merge",
    "-p",
    JSON.stringify({ data: { key: value } }),
  ]);
}

async function expectStored(name: string, value: string): Promise<void> {
  await browser.waitUntil(async () => (await storedValue(name)) === value, {
    timeout: 15000,
    timeoutMsg: `${name} never held ${value} in the cluster`,
  });
}

/** Opens a config map from its row menu and waits for its YAML. */
async function openEditor(name: string, value: string): Promise<string> {
  await openResource("nav-item-core-configmaps", "ConfigMap");
  // The 34 px rows and the dock leave room for about 11 rows, so a row far
  // down the list sits under the dock. Filter the list so the row is at the top.
  await searchResources(name);
  await shown(rowId(NS, name));
  await resourceRowMenu(name, "edit");
  return editorContaining(`key: ${value}`);
}

async function typeValue(
  text: string,
  from: string,
  to: string,
): Promise<void> {
  await setEditorText(text.replace(`key: ${from}`, `key: ${to}`));
  await editorContaining(`key: ${to}`);
}

async function clickSave(): Promise<void> {
  const save = await shown("yaml-save");
  await save.waitForEnabled({ timeout: 15000 });
  await save.click();
}

const PAUSE_IMAGE = "registry.k8s.io/pause:3.10";
/** Ten presses of 24 px make the dock 240 px taller: room for the tree and the details. */
const DOCK_STEPS = 10;

async function until(
  check: () => Promise<boolean>,
  message: string,
  timeout = 15000,
): Promise<void> {
  await browser.waitUntil(check, { timeout, timeoutMsg: message });
}

async function dockHeight(): Promise<number> {
  return Number(await byTestId("dock-resize").getAttribute("aria-valuenow"));
}

/** Moves the dock's edge DOCK_STEPS times with `key` and waits for `height`. */
async function resizeDock(
  key: "ArrowUp" | "ArrowDown",
  height: number,
): Promise<void> {
  await browser.execute(() =>
    document.querySelector<HTMLElement>('[data-testid="dock-resize"]')?.focus(),
  );
  for (let step = 0; step < DOCK_STEPS; step += 1) await browser.keys(key);
  await until(
    async () => (await dockHeight()) === height,
    `the dock never reached ${height} px`,
  );
}

/** Waits for the API docs of the dock tab on screen to show `kind` of `apiVersion`. */
async function expectApiDocs(kind: string, apiVersion: string): Promise<void> {
  await until(
    async () => {
      const shownKind = inDockPanel("api-docs-kind");
      return (
        (await shownKind.isExisting()) &&
        (await shownKind.getText()) === kind &&
        (await inDockPanel("api-docs-version").getText()) === apiVersion
      );
    },
    `the API docs never showed ${kind} ${apiVersion}`,
    30000,
  );
}

/** Opens a create tab, fills it from the template `id` and waits for `part` in the editor. */
async function createFromTemplate(id: string, part: string): Promise<string> {
  await newInDock("create-resource");
  await shown("create-apply");
  await until(
    async () => (await editorText()) !== null,
    "the create tab's editor never loaded",
  );
  await pointerClick(await shown("create-template"));
  await clickWhenShown(`menu-item-${id}`);
  await gone(`menu-item-${id}`);
  return editorContaining(part);
}

type HintEditor = {
  getDomNode(): HTMLElement | null;
  getValue(): string;
  focus(): void;
  setPosition(position: { lineNumber: number; column: number }): void;
  trigger(source: string, action: string, payload: unknown): void;
};

/** Puts the caret of the editor on screen at `line`:`column` (1-based) and runs a Monaco action. */
async function runAt(line: number, column: number, action: string): Promise<void> {
  await browser.execute(
    (l: number, c: number, a: string) => {
      const { monaco } = window as unknown as { monaco?: { editor: { getEditors(): HintEditor[] } } };
      const editor = monaco?.editor.getEditors().find((e) => e.getDomNode()?.offsetParent);
      editor?.focus();
      editor?.setPosition({ lineNumber: l, column: c });
      editor?.trigger("e2e", a, {});
    },
    line,
    column,
    action,
  );
}

async function textOf(selector: string): Promise<string> {
  const found = await browser.$$(selector);
  const texts = await Promise.all([...found].map((element) => element.getText()));
  return texts.join("\n");
}

describe("YAML editor", () => {
  before(async () => {
    await createTestNamespace(NS);
    await openCluster(KIND);
  });

  afterEach(async () => {
    await closeDockTabs();
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("edits a ConfigMap and the cluster reflects it", async () => {
    await createConfigMap("edited", "before");
    const text = await openEditor("edited", "before");

    await typeValue(text, "before", "after");
    await clickSave();

    await expectStored("edited", "after");
    // What was saved now counts as loaded, so there is nothing left to save.
    await byTestId("yaml-save").waitForEnabled({
      timeout: 15000,
      reverse: true,
    });
  });

  it("flags invalid YAML and does not send it", async () => {
    await createConfigMap("invalid", "kept");
    const version = await resourceVersion("invalid");
    await openEditor("invalid", "kept");

    await setEditorText("metadata: [unclosed\n");

    await shown("yaml-error");
    expect(await byTestId("yaml-save").isEnabled()).toBe(false);
    expect(await resourceVersion("invalid")).toBe(version);
    expect(await storedValue("invalid")).toBe("kept");
  });

  it("handles a conflict: reload, then overwrite", async () => {
    await createConfigMap("conflict", "first");
    let text = await openEditor("conflict", "first");

    await changeOnServer("conflict", "server-1");
    await typeValue(text, "first", "mine-1");
    await clickSave();
    await shown("conflict-dialog");
    expect(await storedValue("conflict")).toBe("server-1");

    await clickWhenShown("conflict-reload");
    await gone("conflict-dialog");
    text = await editorContaining("key: server-1");
    expect(await storedValue("conflict")).toBe("server-1");

    await changeOnServer("conflict", "server-2");
    await typeValue(text, "server-1", "mine-2");
    await clickSave();
    await shown("conflict-dialog");

    await clickWhenShown("conflict-overwrite");
    await gone("conflict-dialog");
    await expectStored("conflict", "mine-2");
  });

  it("shows an API validation error verbatim", async () => {
    await createConfigMap("rejected", "kept");
    const text = await openEditor("rejected", "kept");

    // Valid YAML that the API server refuses: an immutable field.
    await setEditorText(text.replace("name: rejected", "name: renamed"));
    await editorContaining("name: renamed");
    await clickSave();

    const notice = await shown("yaml-api-error");
    await browser.waitUntil(async () => (await notice.getText()).length > 0);
    expect(await notice.getText()).toMatch(/rejected|renamed|immutable|name/i);
    expect(await storedValue("rejected")).toBe("kept");
  });

  it("creates multiple documents and reports each", async () => {
    await newInDock("create-resource");
    await shown("create-apply");
    await browser.waitUntil(async () => (await editorText()) !== null, {
      timeout: 15000,
      timeoutMsg: "the create tab's editor never loaded",
    });

    await setEditorText(
      [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: created-ok",
        `  namespace: ${NS}`,
        "data:",
        "  key: created",
        "---",
        "apiVersion: e2e.invalid/v1",
        "kind: NoSuchKind",
        "metadata:",
        "  name: created-bad",
        `  namespace: ${NS}`,
        "",
      ].join("\n"),
    );
    await editorContaining("NoSuchKind");
    const apply = await shown("create-apply");
    await apply.waitForEnabled({ timeout: 15000 });
    await apply.click();

    await shown("apply-results");
    expect(await byTestId("apply-result-0").getAttribute("data-ok")).toBe(
      "true",
    );
    expect(await byTestId("apply-result-1").getAttribute("data-ok")).toBe(
      "false",
    );
    expect(await browser.$$('[data-testid^="apply-result-"]').length).toBe(2);
    expect(await storedValue("created-ok")).toBe("created");
  });

  it("closing a dirty tab asks first", async () => {
    await createConfigMap("dirty", "clean");
    const text = await openEditor("dirty", "clean");
    await typeValue(text, "clean", "unsaved");

    const close = browser.$('[data-testid^="dock-close-"]');
    await close.click();
    await dialogButton("Discard").waitForDisplayed({ timeout: 15000 });

    await dialogButton("Cancel").click();
    await dialogButton("Discard").waitForExist({
      timeout: 15000,
      reverse: true,
    });
    expect(await close.isExisting()).toBe(true);
    expect(await editorText()).toContain("key: unsaved");

    await close.click();
    await dialogButton("Discard").click();
    await close.waitForExist({ timeout: 15000, reverse: true });
    expect(await storedValue("dirty")).toBe("clean");
  });

  it("shows a Deployment's API docs beside its YAML", async () => {
    await kubectl([
      "-n",
      NS,
      "create",
      "deployment",
      "docs",
      `--image=${PAUSE_IMAGE}`,
      "--replicas=0",
    ]);
    await openResource("nav-item-apps-deployments", "Deployment");
    await searchResources("docs");
    await shown(rowId(NS, "docs"));
    await resourceRowMenu("docs", "edit");
    await editorContaining("name: docs");

    const start = await dockHeight();
    await resizeDock("ArrowUp", start + DOCK_STEPS * 24);
    try {
      await expectApiDocs("Deployment", "apps/v1");

      await inDockPanel("api-docs-search").setValue("image");
      await until(async () => {
        const hits = /^(\d+) fields$/.exec(
          await inDockPanel("api-docs-hits").getText(),
        );
        // containers, initContainers and ephemeralContainers each have image and
        // imagePullPolicy, and the pod has imagePullSecrets.
        return hits !== null && Number(hits[1]) >= 7;
      }, "the search never counted the image fields");

      const path = "spec.template.spec.containers[].image";
      const row = await inDockPanel(`api-docs-field-${path}`);
      await row.waitForExist({ timeout: 15000 });
      await browser.execute(
        (el: Element) => el.scrollIntoView({ block: "center" }),
        row as unknown as Element,
      );
      await row.click();

      await until(
        async () => (await inDockPanel("api-docs-path").getText()) === path,
        "the details never showed the image field",
      );
      expect(await inDockPanel("api-docs-facts").getText()).toContain("string");
      expect(await inDockPanel("api-docs-description").getText()).toContain(
        "Container image name",
      );
    } finally {
      await resizeDock("ArrowDown", start);
    }
  });

  it("a create tab shows the API docs of its document's kind", async () => {
    await createFromTemplate("configmap", "kind: ConfigMap");

    await expectApiDocs("ConfigMap", "v1");
  });

  it("the API docs toggle hides the panel in every tab and stays off", async () => {
    await createFromTemplate("configmap", "kind: ConfigMap");
    await expectApiDocs("ConfigMap", "v1");
    const toggle = await inDockPanel("api-docs-toggle");
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");

    await toggle.click();
    await until(
      async () => !(await inDockPanel("api-docs").isExisting()),
      "the API docs never went away",
    );
    expect(await inDockPanel("api-docs-toggle").getAttribute("aria-pressed")).toBe(
      "false",
    );

    await closeDockTabs();
    await createFromTemplate("configmap", "kind: ConfigMap");
    expect(await inDockPanel("api-docs-toggle").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(await inDockPanel("api-docs").isExisting()).toBe(false);

    await inDockPanel("api-docs-toggle").click();
    await expectApiDocs("ConfigMap", "v1");
  });

  it("opens a template from the + picker and hints the Deployment's fields", async () => {
    await pointerClick(await shown("dock-new"));
    await (await shown("dock-new-picker-search")).setValue("deploy");
    await clickWhenShown("menu-item-deployment");
    const text = await editorContaining("kind: Deployment");
    expect(await dockTabTitles()).toContain("New Deployment");

    const lines = text.split("\n");
    const replicas = lines.findIndex((line) => line.startsWith("  replicas:")) + 1;
    await runAt(replicas, 4, "editor.action.showHover");
    await until(async () => (await textOf(".monaco-hover-content")).includes("replicas"), "no hover on replicas");
    expect(await textOf(".monaco-hover-content")).toContain("Number of desired pods");

    await setEditorText(text.replace(/^ {2}replicas: .*$/m, "  "));
    await runAt(replicas, 3, "editor.action.triggerSuggest");
    await until(async () => (await textOf(".suggest-widget .monaco-list-row")).includes("replicas"), "completion never offered replicas");
  });
});
