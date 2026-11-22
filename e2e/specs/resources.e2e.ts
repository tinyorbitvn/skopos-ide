import path from "node:path";
import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  expectResourceTitle,
  expectRows,
  expectRowsExactly,
  gone,
  openCluster,
  openResource,
  pointerClick,
  resourceRowMenu,
  rowId,
  rowIds,
  searchResources,
  shown,
  tableHeaders,
  toggleInCheckMenu,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-e2e";
/** A namespace of its own, so its Pods are exactly what the order test lists. */
const ORDER_NS = "skopos-test-order";
const WORKLOADS = path.resolve(__dirname, "..", "fixtures", "workloads.yaml");
const PAUSE_IMAGE = "registry.k8s.io/pause:3.10";
const SECRET_VALUE = "ZTJlLXNlY3JldA==";
const SECRET_VALUE_DECODED = "e2e-secret";
/** The 1 s of spec F5, plus what WebDriver and kubectl take. */
const LIVE_UPDATE_LIMIT_MS = 1500;

const PODS = "nav-item-core-pods";
const CONFIGMAPS = "nav-item-core-configmaps";

/** The sections of F4 this phase ships, with every entry under each. */
const SIDEBAR: Record<string, string[]> = {
  nodes: ["core-nodes"],
  workloads: [
    "core-pods",
    "apps-deployments",
    "apps-daemonsets",
    "apps-statefulsets",
    "apps-replicasets",
    "batch-jobs",
    "batch-cronjobs",
  ],
  config: [
    "core-configmaps",
    "core-secrets",
    "core-resourcequotas",
    "core-limitranges",
    "autoscaling-horizontalpodautoscalers",
    "policy-poddisruptionbudgets",
    "scheduling.k8s.io-priorityclasses",
    "node.k8s.io-runtimeclasses",
    "coordination.k8s.io-leases",
    "admissionregistration.k8s.io-mutatingwebhookconfigurations",
    "admissionregistration.k8s.io-validatingwebhookconfigurations",
  ],
  network: [
    "core-services",
    "discovery.k8s.io-endpointslices",
    "networking.k8s.io-ingresses",
    "networking.k8s.io-ingressclasses",
    "networking.k8s.io-networkpolicies",
  ],
  storage: [
    "core-persistentvolumeclaims",
    "core-persistentvolumes",
    "storage.k8s.io-storageclasses",
  ],
  devices: [
    "resource.k8s.io-resourceclaims",
    "resource.k8s.io-resourceclaimtemplates",
    "resource.k8s.io-deviceclasses",
    "resource.k8s.io-resourceslices",
  ],
  namespaces: ["core-namespaces"],
  events: ["core-events"],
  access: [
    "core-serviceaccounts",
    "rbac.authorization.k8s.io-clusterroles",
    "rbac.authorization.k8s.io-roles",
    "rbac.authorization.k8s.io-clusterrolebindings",
    "rbac.authorization.k8s.io-rolebindings",
  ],
  custom: ["apiextensions.k8s.io-customresourcedefinitions"],
};

async function createConfigMap(name: string): Promise<void> {
  await kubectl([
    "-n",
    NS,
    "create",
    "configmap",
    name,
    "--from-literal=key=value",
  ]);
}

async function configMapExists(name: string): Promise<boolean> {
  const found = await kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    name,
    "--ignore-not-found",
    "-o",
    "name",
  ]);
  return found.trim() !== "";
}

/** Waits until a new object's creation second has passed, as timestamps have no finer unit. */
async function nextCreationSecond(configMap: string): Promise<void> {
  const created = await kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    configMap,
    "-o",
    "jsonpath={.metadata.creationTimestamp}",
  ]);
  const after = Date.parse(created) + 1000;
  await browser.waitUntil(async () => Date.now() >= after, { interval: 50 });
}

/** Deployment `alpha` and a bare Pod `zulu`, whose Pods list as alpha's, then zulu. */
const ORDER_MANIFEST = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: alpha
  namespace: ${ORDER_NS}
spec:
  replicas: 1
  selector:
    matchLabels: { app: alpha }
  template:
    metadata:
      labels: { app: alpha }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: main
          image: ${PAUSE_IMAGE}
---
apiVersion: v1
kind: Pod
metadata:
  name: zulu
  namespace: ${ORDER_NS}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: main
      image: ${PAUSE_IMAGE}
`;

/** The names of the Pods of Deployment `alpha`. */
async function alphaPods(): Promise<string[]> {
  const names = await kubectl([
    "-n",
    ORDER_NS,
    "get",
    "pods",
    "-l",
    "app=alpha",
    "-o",
    "jsonpath={.items[*].metadata.name}",
  ]);
  return names.split(" ").filter(Boolean);
}

async function clickSortHeader(header: string): Promise<void> {
  await byTestId("resource-table").$(`button=${header}`).click();
}

describe("resource browsing on a real cluster", () => {
  before(async () => {
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", WORKLOADS]);
    await browser.waitUntil(
      async () => {
        const pods = await kubectl([
          "-n",
          NS,
          "get",
          "pods",
          "-l",
          "app=web",
          "-o",
          "name",
        ]);
        return pods.trim().split("\n").filter(Boolean).length === 2;
      },
      {
        timeout: 60000,
        interval: 500,
        timeoutMsg: "the web pods were never created",
      },
    );
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(ORDER_NS);
    await deleteTestNamespace(NS);
  });

  it("shows the F4 sidebar sections for an admin", async () => {
    await shown("nav-overview");
    await byTestId("nav-overview-workloads").waitForExist({ timeout: 15000 });
    for (const [section, items] of Object.entries(SIDEBAR)) {
      await byTestId(`nav-section-${section}`).waitForExist({ timeout: 15000 });
      for (const item of items) {
        expect(await byTestId(`nav-item-${item}`).isExisting()).toBe(true);
      }
    }
  });

  it("lists Device Resources: a DeviceClass with its selector and a Pending ResourceClaim", async () => {
    const CLASS = "skopos-e2e.example.com";
    const CLAIM = "skopos-e2e-claim";
    await kubectl(
      ["apply", "-f", "-"],
      `apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: ${CLASS}
spec:
  selectors:
    - cel:
        expression: device.driver == "${CLASS}"
---
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: ${CLAIM}
  namespace: ${NS}
spec:
  devices:
    requests:
      - name: gpu
        exactly:
          deviceClassName: ${CLASS}
`,
    );
    try {
      await openResource("nav-item-resource.k8s.io-deviceclasses", "DeviceClass");
      await clickWhenShown(`resource-row-${CLASS}`);
      await shown("detail-drawer");
      await browser.waitUntil(
        async () =>
          (await byTestId("detail-drawer").getText()).includes(
            `device.driver == "${CLASS}"`,
          ),
        { timeoutMsg: "the DeviceClass drawer never showed its selector" },
      );
      await clickWhenShown("detail-close");
      await gone("detail-drawer");

      await openResource("nav-item-resource.k8s.io-resourceclaims", "ResourceClaim");
      const row = await shown(rowId(NS, CLAIM));
      await browser.waitUntil(async () => (await row.getText()).includes("Pending"), {
        timeoutMsg: "the claim never showed Pending",
      });
      expect(await row.getText()).toContain(CLASS);
      await row.click();
      await shown("device-requests");
      expect(await byTestId("device-requests").getText()).toContain(CLASS);
      expect(await byTestId("claim-devices").isExisting()).toBe(false);
      await clickWhenShown("detail-close");
      await gone("detail-drawer");
    } finally {
      await kubectl(["-n", NS, "delete", "resourceclaim", CLAIM, "--ignore-not-found"]);
      await kubectl(["delete", "deviceclass", CLASS, "--ignore-not-found"]);
    }
  });

  it("lists pods and shows a new one within 1 s of creation", async () => {
    await openResource(PODS, "Pod");
    await expectRows("kube-system pods", (ids) =>
      ids.some((id) => id.startsWith("resource-row-kube-system-")),
    );

    const row = byTestId(rowId(NS, "live-pod"));
    const started = Date.now();
    await kubectl([
      "-n",
      NS,
      "run",
      "live-pod",
      `--image=${PAUSE_IMAGE}`,
      "--restart=Never",
    ]);
    await browser.waitUntil(() => row.isExisting(), {
      timeout: 15000,
      interval: 50,
      timeoutMsg: "the new pod never appeared",
    });
    expect(Date.now() - started).toBeLessThan(LIVE_UPDATE_LIMIT_MS);
  });

  it("removes a row when the object is deleted", async () => {
    await shown(rowId(NS, "live-pod"));
    await kubectl([
      "-n",
      NS,
      "delete",
      "pod",
      "live-pod",
      "--grace-period=0",
      "--force",
    ]);
    await gone(rowId(NS, "live-pod"));
  });

  it("shows a Deployment's replacement Pod in its sorted place after its Pod is deleted", async () => {
    await createTestNamespace(ORDER_NS);
    await kubectl(["apply", "-f", "-"], ORDER_MANIFEST);
    await kubectl([
      "-n",
      ORDER_NS,
      "rollout",
      "status",
      "deployment/alpha",
      "--timeout=120s",
    ]);
    const [old] = await alphaPods();
    const zulu = rowId(ORDER_NS, "zulu");

    // Opened again, the list starts from a snapshot of what is there now.
    await openResource(CONFIGMAPS, "ConfigMap");
    await openResource(PODS, "Pod");
    await toggleInCheckMenu("namespace-filter", [
      `namespace-option-${ORDER_NS}`,
    ]);
    try {
      await expectRowsExactly([rowId(ORDER_NS, old), zulu]);

      await kubectl(["-n", ORDER_NS, "delete", "pod", old, "--wait=false"]);
      let last: string[] = [];
      await browser
        .waitUntil(
          async () => {
            last = await rowIds();
            return (
              last.length === 2 &&
              last[0].startsWith(rowId(ORDER_NS, "alpha-")) &&
              last[0] !== rowId(ORDER_NS, old) &&
              last[1] === zulu
            );
          },
          { timeout: 10000, interval: 100 },
        )
        .catch(() => {
          throw new Error(
            `the replacement of ${old} never showed before zulu; the table has ${last.join(", ")}`,
          );
        });
    } finally {
      // The later tests start from All namespaces.
      await toggleInCheckMenu("namespace-filter", [
        `namespace-option-${ORDER_NS}`,
      ]);
    }
    await deleteTestNamespace(ORDER_NS);
  });

  it("filters by namespace, and the filter survives navigating away and back", async () => {
    await openResource(PODS, "Pod");
    const inNamespace = (ids: string[]) =>
      ids.length > 0 && ids.every((id) => id.startsWith(`resource-row-${NS}-`));

    await toggleInCheckMenu("namespace-filter", [`namespace-option-${NS}`]);
    await expectRows(`only pods of ${NS}`, inNamespace);
    expect(await byTestId("namespace-filter").getText()).toBe(NS);

    await openResource(CONFIGMAPS, "ConfigMap");
    await expectRows(`only config maps of ${NS}`, inNamespace);

    await openResource(PODS, "Pod");
    expect(await byTestId("namespace-filter").getText()).toBe(NS);
    await expectRows(`only pods of ${NS} again`, inNamespace);
  });

  it("searches by name and by label", async () => {
    await openResource(PODS, "Pod");

    await searchResources("app=web");
    await expectRows("the two web pods", (ids) => {
      return (
        ids.length === 2 &&
        ids.every((id) => id.startsWith(`resource-row-${NS}-web-`))
      );
    });

    await searchResources("once");
    await expectRows("the pod of the job", (ids) => {
      return ids.length === 1 && ids[0].startsWith(`resource-row-${NS}-once-`);
    });

    await searchResources("no-such-object");
    await expectRowsExactly([]);
  });

  it("filters by column values: a status, an age, and a hidden IP", async () => {
    await openResource(PODS, "Pod");
    const web = (ids: string[]) =>
      ids.filter((id) => id.startsWith(`resource-row-${NS}-web-`));
    const once = (ids: string[]) =>
      ids.filter((id) => id.startsWith(`resource-row-${NS}-once-`));

    await searchResources("status = Running");
    await expectRows(
      "the web pods, without the finished job's pod",
      (ids) => web(ids).length === 2 && once(ids).length === 0,
    );

    await searchResources("age < 1d");
    await expectRows(
      "every pod of the fixture",
      (ids) => web(ids).length === 2 && once(ids).length === 1,
    );

    await searchResources("age > 1y");
    await expectRowsExactly([]);

    // IP is hidden in a Pod list; free text still finds it, and the row says so.
    const podQuery = ["-n", NS, "get", "pods", "-l", "app=web", "-o"];
    const ip = (
      await kubectl([...podQuery, "jsonpath={.items[0].status.podIP}"])
    ).trim();
    const name = (
      await kubectl([...podQuery, "jsonpath={.items[0].metadata.name}"])
    ).trim();
    expect(ip).not.toBe("");
    await searchResources(ip);
    await expectRows("the pod with that IP", (ids) =>
      ids.includes(rowId(NS, name)),
    );
    const chip = (await shown(rowId(NS, name))).$(
      '[data-testid="filter-chip"]',
    );
    await chip.waitForExist({ timeout: 10000 });
    expect(await chip.getAttribute("title")).toBe(`column ip=${ip}`);

    await searchResources("");
  });

  it("sorts by age and by name", async () => {
    await createConfigMap("sort-z-older");
    await nextCreationSecond("sort-z-older");
    await createConfigMap("sort-a-newer");
    const older = rowId(NS, "sort-z-older");
    const newer = rowId(NS, "sort-a-newer");

    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("sort-");
    await expectRows("both config maps", (ids) => ids.length === 2);

    await clickSortHeader("Name");
    await expectRowsExactly([newer, older]);
    await clickSortHeader("Name");
    await expectRowsExactly([older, newer]);

    // Ascending age puts the youngest first.
    await clickSortHeader("Age");
    await expectRowsExactly([newer, older]);
    await clickSortHeader("Age");
    await expectRowsExactly([older, newer]);
  });

  it("hides and restores a column", async () => {
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("");
    await shown(rowId(NS, "app-config"));
    expect(await tableHeaders()).toContain("Namespace");

    await toggleInCheckMenu("columns-menu", ["column-option-namespace"]);
    await browser.waitUntil(
      async () => !(await tableHeaders()).includes("Namespace"),
      {
        timeoutMsg: "the column stayed",
      },
    );

    // The choice is kept per kind.
    await openResource(PODS, "Pod");
    await expectRows("some pods", (ids) => ids.length > 0);
    expect(await tableHeaders()).toContain("Namespace");
    await openResource(CONFIGMAPS, "ConfigMap");
    await shown(rowId(NS, "app-config"));
    expect(await tableHeaders()).not.toContain("Namespace");

    await toggleInCheckMenu("columns-menu", ["column-option-namespace"]);
    await browser.waitUntil(
      async () => (await tableHeaders()).includes("Namespace"),
      {
        timeoutMsg: "the column never came back",
      },
    );
  });

  it("opens the drawer with metadata, labels, owner link and events", async () => {
    await openResource(PODS, "Pod");
    await searchResources("app=web");
    await expectRows("the two web pods", (ids) => ids.length === 2);
    const [row] = await rowIds();
    const podName = row.slice(`resource-row-${NS}-`.length);

    await byTestId(row).click();
    await shown("detail-drawer");
    expect(await byTestId("detail-title").getText()).toContain(podName);
    const uid = await kubectl([
      "-n",
      NS,
      "get",
      "pod",
      podName,
      "-o",
      "jsonpath={.metadata.uid}",
    ]);
    const drawer = await byTestId("detail-drawer").getText();
    expect(drawer).toContain(NS);
    expect(drawer).toContain(uid);
    expect(await byTestId("detail-labels").getText()).toContain("app=web");
    await pointerClick(await byTestId("detail-drawer").$("button=Events"));
    await browser.waitUntil(
      async () =>
        (await shown("detail-events"))
          .getText()
          .then((text) => text.includes("Scheduled")),
      { timeout: 15000, timeoutMsg: "the pod's events never showed" },
    );

    await pointerClick(await byTestId("detail-drawer").$("button=Overview"));
    await clickWhenShown("detail-owner-link");
    // The owner opens in the drawer, over the Pods list (spec H43).
    await browser.waitUntil(
      async () =>
        (await byTestId("detail-kind").getText()) === "ReplicaSet" &&
        (await byTestId("detail-title").getText()).includes("web-"),
      { timeoutMsg: "the drawer never showed the ReplicaSet" },
    );
    expect(await byTestId("resource-title").getText()).toBe("Pod");
    await clickWhenShown("detail-back");
    await browser.waitUntil(
      async () =>
        (await byTestId("detail-kind").getText()) === "Pod" &&
        (await byTestId("detail-title").getText()).includes(podName),
      { timeoutMsg: "Back never returned to the Pod" },
    );
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });

  it("resizes the navigation and the drawer, and keeps their widths", async () => {
    /** Focuses a resize handle and presses `key` `times` times. */
    const press = async (testId: string, key: string, times: number) => {
      await browser.execute(
        (id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.focus(),
        testId,
      );
      for (let i = 0; i < times; i += 1) await browser.keys(key);
    };
    const widthOf = async (testId: string) =>
      (await byTestId(testId).getSize()).width;
    const valueOf = async (testId: string) =>
      Number(await byTestId(testId).getAttribute("aria-valuenow"));

    await openResource(PODS, "Pod");
    await searchResources("app=web");
    await expectRows("the two web pods", (ids) => ids.length === 2);
    const [row] = await rowIds();

    const nav = await valueOf("nav-resize");
    await press("nav-resize", "ArrowRight", 2);
    await browser.waitUntil(async () => (await valueOf("nav-resize")) === nav + 32, {
      timeoutMsg: "the navigation never grew by two steps",
    });
    // The pane width is the glass column's, border included (spec Q §1).
    expect(Math.round(await widthOf("sidebar-column"))).toBe(nav + 32);

    const tableWidth = await widthOf("resource-table");
    await byTestId(row).click();
    await shown("detail-drawer");
    // The drawer floats over the list, so the table keeps its width (spec H12).
    expect(await widthOf("resource-table")).toBe(tableWidth);
    const drawer = await valueOf("drawer-resize");
    // The drawer's handle is on its left border, so ArrowLeft widens it.
    await press("drawer-resize", "ArrowLeft", 3);
    await browser.waitUntil(
      async () => (await valueOf("drawer-resize")) === drawer + 48,
      { timeoutMsg: "the drawer never grew by three steps" },
    );
    expect(Math.round(await widthOf("detail-drawer"))).toBe(drawer + 48);

    // A drawer opened again comes back at the width it was given.
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
    await byTestId(row).click();
    await shown("detail-drawer");
    expect(await valueOf("drawer-resize")).toBe(drawer + 48);

    // Double-click puts both back to their defaults. WebKitWebDriver's doubleClick sends two
    // single clicks and no dblclick event, so the test sends that event itself.
    await browser.execute(() => {
      for (const id of ["drawer-resize", "nav-resize"]) {
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      }
    });
    await browser.waitUntil(
      async () =>
        (await valueOf("drawer-resize")) === 420 &&
        (await valueOf("nav-resize")) === 248,
      { timeoutMsg: "a double-click never reset the widths" },
    );
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });

  it("resizes a column by dragging its edge, keeps its width per kind, and resets it", async () => {
    /** The header cell's width on screen and the width its handle reports. */
    const namespace = () =>
      browser.execute(() => {
        const handle = document.querySelector('[data-testid="column-resize-namespace"]');
        const now = handle?.getAttribute("aria-valuenow");
        return {
          cell: Math.round(handle?.parentElement?.getBoundingClientRect().width ?? 0),
          given: now ? Number(now) : null,
        };
      });

    await openResource(PODS, "Pod");
    await shown("column-resize-namespace");
    const before = await namespace();
    expect(before.given).toBeNull();

    // A real drag: press on the handle, move 60 px to the right in steps, release. The
    // Namespace column is on screen at every window width, where a column at the right
    // end can sit under the table's own scroll edge.
    const handle = await byTestId("column-resize-namespace");
    const at = await handle.getLocation();
    const size = await handle.getSize();
    const x = Math.round(at.x + size.width / 2);
    const y = Math.round(at.y + size.height / 2);
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x, y })
      .down({ button: 0 })
      .move({ x: x + 20, y, duration: 50 })
      .move({ x: x + 40, y, duration: 50 })
      .move({ x: x + 60, y, duration: 50 })
      .up({ button: 0 })
      .perform();
    await browser.waitUntil(async () => (await namespace()).given === before.cell + 60, {
      timeoutMsg: "the drag never made the Namespace column 60 px wider",
    });
    expect((await namespace()).cell).toBe(before.cell + 60);

    // Another kind has its own widths; Pods come back with the width given.
    await openResource(CONFIGMAPS, "ConfigMap");
    await shown("column-resize-namespace");
    expect((await namespace()).given).toBeNull();
    await openResource(PODS, "Pod");
    await browser.waitUntil(async () => (await namespace()).given === before.cell + 60, {
      timeoutMsg: "the Pod list lost the Namespace column's width",
    });

    // WebKitWebDriver's doubleClick sends no dblclick event, so the test sends it itself.
    await browser.execute(() => {
      document
        .querySelector('[data-testid="column-resize-namespace"]')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
    await browser.waitUntil(async () => (await namespace()).given === null, {
      timeoutMsg: "a double-click never reset the Namespace column",
    });
    expect((await namespace()).cell).toBe(before.cell);
  });

  it("back and forward navigate between resource views", async () => {
    await openResource(PODS, "Pod");
    await openResource(CONFIGMAPS, "ConfigMap");

    await browser.keys(["Alt", "ArrowLeft"]);
    await expectResourceTitle("Pod");

    await browser.keys(["Alt", "ArrowRight"]);
    await expectResourceTitle("ConfigMap");
  });

  it("deletes one object after confirmation and bulk deletes two", async () => {
    for (const name of ["del-one", "del-two", "del-three"])
      await createConfigMap(name);
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("del-");
    await expectRows("the three config maps", (ids) => ids.length === 3);

    await resourceRowMenu("del-one", "delete");
    await shown("delete-confirm");
    expect(await configMapExists("del-one")).toBe(true);
    await clickWhenShown("delete-confirm");
    await gone(rowId(NS, "del-one"));
    await gone("delete-confirm");
    expect(await configMapExists("del-one")).toBe(false);

    for (const name of ["del-two", "del-three"]) {
      await browser.$(`input[aria-label="Select ${NS}/${name}"]`).click();
    }
    await browser.waitUntil(
      async () => (await byTestId("bulk-delete").getText()) === "Delete (2)",
      { timeoutMsg: "the bulk delete button never counted two" },
    );
    await clickWhenShown("bulk-delete");
    await clickWhenShown("delete-confirm");
    await gone(rowId(NS, "del-two"));
    await gone(rowId(NS, "del-three"));
    expect(await configMapExists("del-two")).toBe(false);
    expect(await configMapExists("del-three")).toBe(false);
  });

  it("shows Secret names but the value is not in page content", async () => {
    await openResource("nav-item-core-secrets", "Secret");
    await shown(rowId(NS, "app-secret"));

    const leaks = async () => {
      const page: string = await browser.execute(
        () => document.documentElement.outerHTML,
      );
      return page.includes(SECRET_VALUE) || page.includes(SECRET_VALUE_DECODED);
    };
    expect(await byTestId("resource-table").getText()).toContain("app-secret");
    expect(await leaks()).toBe(false);

    await byTestId(rowId(NS, "app-secret")).click();
    await shown("detail-drawer");
    await browser.waitUntil(
      async () =>
        (await byTestId("detail-title").getText()).includes("app-secret"),
      { timeoutMsg: "the drawer never showed the Secret" },
    );
    expect(await leaks()).toBe(false);
    await clickWhenShown("detail-close");
  });

  it("updates a changed row live and keeps the age column ticking", async () => {
    await createConfigMap("live-row");
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("tier=blue");
    await expectRowsExactly([]);

    const row = rowId(NS, "live-row");
    const started = Date.now();
    await kubectl([
      "-n",
      NS,
      "label",
      "configmap",
      "live-row",
      "tier=blue",
    ]);
    await browser.waitUntil(() => byTestId(row).isExisting(), {
      timeout: 15000,
      interval: 50,
      timeoutMsg: "the changed row never matched its new label",
    });
    expect(Date.now() - started).toBeLessThan(LIVE_UPDATE_LIMIT_MS);

    // The age is drawn from a shared 30 s clock, so it moves without any event.
    const before = await byTestId(row).getText();
    await browser.waitUntil(async () => (await byTestId(row).getText()) !== before, {
      timeout: 45000,
      timeoutMsg: "the age column never changed",
    });
  });

  it("shows annotations and conditions in the drawer, and updates it live", async () => {
    await kubectl([
      "-n",
      NS,
      "annotate",
      "configmap",
      "live-row",
      "note=first",
      "--overwrite",
    ]);
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("live-row");
    await byTestId(rowId(NS, "live-row")).click();
    await shown("detail-drawer");
    // Annotations are an expander (spec H31): it is opened to read the values.
    await clickWhenShown("detail-expand-annotations");
    await browser.waitUntil(
      async () =>
        (await shown("detail-annotations")).getText().then((t) => /note\s*first/.test(t)),
      { timeoutMsg: "the annotation never showed" },
    );

    // The drawer follows the object while it is open.
    await kubectl([
      "-n",
      NS,
      "annotate",
      "configmap",
      "live-row",
      "note=second",
      "--overwrite",
    ]);
    await browser.waitUntil(
      async () =>
        /note\s*second/.test(await byTestId("detail-annotations").getText()),
      { timeout: 15000, timeoutMsg: "the open drawer never updated" },
    );

    // Pods carry status conditions.
    await clickWhenShown("detail-close");
    await openResource(PODS, "Pod");
    await searchResources("app=web");
    await expectRows("the two web pods", (ids) => ids.length === 2);
    const [pod] = await rowIds();
    await byTestId(pod).click();
    await shown("detail-conditions");
    expect(await byTestId("detail-conditions").getText()).toContain("Ready");
    await clickWhenShown("detail-close");
  });

  it("navigates back and forward with the mouse buttons", async () => {
    await openResource(PODS, "Pod");
    await openResource(CONFIGMAPS, "ConfigMap");
    const press = (button: number) =>
      browser.execute((b) => {
        window.dispatchEvent(
          new MouseEvent("mouseup", { button: b, cancelable: true }),
        );
      }, button);
    await press(3);
    await expectResourceTitle("Pod");
    await press(4);
    await expectResourceTitle("ConfigMap");
  });

  it("draws each node's Disk as a share of its root filesystem", async () => {
    await openResource("nav-item-core-nodes", "Node");
    await expectRows("the kind nodes", (ids) => ids.length > 0);
    expect(await tableHeaders()).toContain("Disk");
    const rows = await rowIds();
    const disk = (row: string) => byTestId(row).$('[data-testid="usage-disk"]');
    await browser.waitUntil(
      async () => {
        for (const row of rows) {
          if (!/^\d+%$/.test(await disk(row).getText())) return false;
        }
        return true;
      },
      { timeout: 30000, interval: 500, timeoutMsg: "a node's Disk cell never showed a share" },
    );
    for (const row of rows) {
      expect(await disk(row).getAttribute("title")).toMatch(/^\S+ \S+ of \S+ \S+$/);
      const meter = disk(row).$('[role="meter"]');
      expect(Number(await meter.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    }
  });

  it("keeps the Actions cell opaque in a narrow list scrolled sideways", async () => {
    await openResource("nav-item-core-nodes", "Node");
    await expectRows("the kind node", (ids) => ids.length > 0);
    const [row] = await rowIds();
    const nodeName = row.slice("resource-row-".length);
    // The list is narrowed in the page and scrolled to its end, under the sticky Actions cell.
    const point = await browser.execute((id) => {
      const screen = document.querySelector<HTMLElement>('[data-testid="resource-screen"]');
      const table = document.querySelector<HTMLElement>('[data-testid="resource-table"]');
      const line = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!screen || !table || !line) return null;
      screen.style.maxWidth = "480px";
      let scroller: HTMLElement | null = table.parentElement;
      while (scroller && scroller !== screen && scroller.scrollWidth <= scroller.clientWidth) {
        scroller = scroller.parentElement;
      }
      if (!scroller || scroller === screen) return null;
      scroller.scrollLeft = scroller.scrollWidth;
      const box = scroller.getBoundingClientRect();
      const r = line.getBoundingClientRect();
      return {
        scrolled: scroller.scrollLeft > 0,
        x: Math.round(box.left + 40),
        y: Math.round(r.top + r.height / 2),
      };
    }, row);
    expect(point?.scrolled).toBe(true);
    // The real pointer hovers the row, as in the reported bug.
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: point?.x ?? 0, y: point?.y ?? 0 })
      .perform();
    const background = await browser.execute((name) => {
      const cell = document.querySelector(`[data-testid="row-menu-${name}"]`)?.closest("td");
      return cell ? getComputedStyle(cell).backgroundColor : "";
    }, nodeName);
    // Opaque: rgb(), or rgba() with alpha 1 (spec H68, H70).
    expect(background).toMatch(/^rgb\(|^rgba\(\d+, \d+, \d+, 1\)$/);
    await browser.execute(() => {
      const screen = document.querySelector<HTMLElement>('[data-testid="resource-screen"]');
      if (screen) screen.style.maxWidth = "";
    });
  });
});
