import fs from "node:fs";
import path from "node:path";
import { expectToast } from "../helpers/helm";
import { kubectl } from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  gone,
  openCluster,
  expectRows,
  expectRowsExactly,
  openResource,
  pickFilterSuggestion,
  pointerClick,
  rowId,
  searchResources,
  shown,
  tableHeaders,
} from "../helpers/ui";

// e2e/helpers/fixtures.ts creates these objects before the app starts (spec E §18.3).
const KIND = "kind-skopos-e2e";
const NS = "skopos-e2e-map";
const GATEWAY_GROUP = "gateway.networking.k8s.io";
// The standard v1.7.0 kinds, in the order Network lists them (spec M2).
const NETWORK_GATEWAY_KINDS = [
  "gatewayclasses",
  "gateways",
  "listenersets",
  "httproutes",
  "grpcroutes",
  "tlsroutes",
  "tcproutes",
  "udproutes",
  "backendtlspolicies",
  "referencegrants",
];
// The test puts this annotation on the fixture's Pod (spec M31).
const FILTER_KEY = "skopos-e2e/filter";
const FILTER_VALUE = "found";

const DEPLOYMENT = `Deployment/${NS}/web`;
// Ids ending in "-" are prefixes of generated names.
const REPLICA_SET = `ReplicaSet/${NS}/web-`;
const POD = `Pod/${NS}/web-`;
const SERVICE = `Service/${NS}/web`;
const INGRESS = `Ingress/${NS}/web`;
const ROUTE = `HTTPRoute/${NS}/web`;
const GATEWAY = `Gateway/${NS}/edge`;
const CLASS = `GatewayClass//${NS}`;
const CONFIG = `ConfigMap/${NS}/web-config`;
const SECRET = `Secret/${NS}/web-secret`;
const ACCOUNT = `ServiceAccount/${NS}/web`;
const CLAIM = `PersistentVolumeClaim/${NS}/web-data`;
const OBJECTS = [
  DEPLOYMENT,
  REPLICA_SET,
  POD,
  SERVICE,
  INGRESS,
  ROUTE,
  GATEWAY,
  CLASS,
  CONFIG,
  SECRET,
  ACCOUNT,
  CLAIM,
];

// The ServiceAccount's access (spec O §8.3). The Role web-leader does not exist.
const READER_BINDING = `RoleBinding/${NS}/web-config-reader`;
const READER_ROLE = `Role/${NS}/web-config-reader`;
const VIEW_BINDING = "ClusterRoleBinding//skopos-e2e-map-web-view";
const VIEW_ROLE = "ClusterRole//view";
const LEADER_BINDING = `RoleBinding/${NS}/web-leader`;
const LEADER_ROLE = `Role/${NS}/web-leader`;
const ACCESS: [string, string, string][] = [
  [READER_BINDING, "binds", ACCOUNT],
  [VIEW_BINDING, "binds", ACCOUNT],
  [LEADER_BINDING, "binds", ACCOUNT],
  [READER_BINDING, "grants", READER_ROLE],
  [VIEW_BINDING, "grants", VIEW_ROLE],
  [LEADER_BINDING, "grants", LEADER_ROLE],
];
// Where the save dialog's answer puts the exported map; removed when the test ends.
const EXPORT_DIR = path.resolve(__dirname, "..", ".tmp", "map-export");
const EXPORTS = {
  png: path.join(EXPORT_DIR, "map.png"),
  pdf: path.join(EXPORT_DIR, "map.pdf"),
};

const until = (
  check: () => Promise<boolean>,
  timeoutMsg: string,
  timeout = 30000,
) => browser.waitUntil(check, { timeout, interval: 500, timeoutMsg });

const idMatch = (attr: string, id: string) =>
  id.endsWith("-") ? `[${attr}^="${id}"]` : `[${attr}="${id}"]`;

function node(id: string) {
  return $(`[data-testid="map-node"]${idMatch("data-id", id)}`);
}

function edge(from: string, rel: string, to: string) {
  return $(
    `[data-testid="map-edge"]${idMatch("data-from", from)}[data-rel="${rel}"]${idMatch("data-to", to)}`,
  );
}

/**
 * Waits until an element stays put for one poll. Opening the details pane narrows the
 * canvas, and the view refits on resize (spec E §8.2), so the nodes move just after a
 * selection; a click measured before that lands where the node was.
 */
async function stopped(element: WebdriverIO.Element): Promise<void> {
  let last = "";
  await browser.waitUntil(
    async () => {
      const now = JSON.stringify([
        await element.getLocation(),
        await element.getSize(),
      ]);
      const same = now === last;
      last = now;
      return same;
    },
    { timeout: 10000, interval: 250, timeoutMsg: "the node kept moving" },
  );
}

/** Whether the point `pointerClick` aims at, the ring's centre, hits the ring's own node. */
async function onTop(ring: WebdriverIO.Element): Promise<boolean> {
  return browser.execute((el: Element) => {
    const box = el.getBoundingClientRect();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const own = el.closest('[data-testid="map-node"]');
    const hit = document
      .elementFromPoint(x, y)
      ?.closest('[data-testid="map-node"]');
    return own !== null && hit === own;
  }, ring as unknown as Element);
}

/**
 * Clicks a node's ring, so the click lands on the node and not between its parts,
 * and waits for the details pane of "‹Kind› ‹name›".
 *
 * The pane narrows the canvas and the view refits when its ResizeObserver reports, which
 * WebKit can deliver a second late. Until then a node by the right edge lies under the
 * pane, so the click waits for the ring to be on top; and a refit landing during the
 * click moves the node away, so the click is tried again. Selecting a selected node
 * changes nothing.
 */
async function select(id: string, label: string): Promise<void> {
  await node(id).waitForExist({ timeout: 30000 });
  const shows = async () => {
    const details = byTestId("map-details");
    return (
      (await details.isExisting()) &&
      (await details.getAttribute("aria-label")) === label
    );
  };
  await until(
    async () => {
      const ring = await node(id).$("circle");
      if (!(await onTop(ring))) return false;
      await stopped(ring);
      if (!(await onTop(ring))) return false;
      await pointerClick(ring);
      return browser
        .waitUntil(shows, { timeout: 3000, interval: 250 })
        .catch(() => false);
    },
    `selecting ${id} never showed the details of ${label}`,
  );
}

async function summaryCount(): Promise<number> {
  const text = await (await shown("map-summary")).getText();
  return Number.parseInt(text.replace(/,/g, ""), 10);
}

async function focus(): Promise<string | null> {
  const page = byTestId("map-page");
  return (await page.isExisting()) ? page.getAttribute("data-focus") : null;
}

const opacity = async (id: string) =>
  Number((await node(id).getCSSProperty("opacity")).value);

/** Opens a popover of the filters row, unless it is open. */
async function openFilter(which: "ns" | "kind"): Promise<void> {
  if (!(await byTestId(`map-${which}-popover`).isExisting())) {
    await clickWhenShown(`map-${which}-filter`);
  }
  await shown(`map-${which}-popover`);
}

/** Closes a popover with Escape from its search box (spec H59). */
async function closeFilter(which: "ns" | "kind"): Promise<void> {
  await clickWhenShown(`map-${which}-search`);
  await browser.keys("Escape");
  await gone(`map-${which}-popover`);
}

/** Checks or unchecks a box of an open popover. */
async function setBox(testId: string, checked: boolean): Promise<void> {
  const box = await shown(testId);
  if ((await box.isSelected()) !== checked) await box.click();
  await browser.waitUntil(async () => (await byTestId(testId).isSelected()) === checked, {
    timeout: 5000,
    timeoutMsg: `${testId} never turned ${checked ? "on" : "off"}`,
  });
}

/** Shows only `namespace`: Clear hides the listed namespaces, then its box shows it. */
async function onlyNamespace(namespace: string): Promise<void> {
  await openFilter("ns");
  if (await byTestId("map-ns-clear").isEnabled()) {
    await clickWhenShown("map-ns-clear");
  }
  await setBox(`map-ns-option-${namespace}`, true);
  await closeFilter("ns");
  await until(
    async () => (await byTestId("map-ns-filter").getText()) === namespace,
    `the Namespaces filter never showed only ${namespace}`,
  );
}

/** Chooses a layout and waits until it is the chosen one. */
async function chooseLayout(
  layout: "grouped" | "layered" | "force",
): Promise<void> {
  await clickWhenShown(`map-layout-${layout}`);
  await until(
    async () =>
      (await byTestId(`map-layout-${layout}`).$("input")).isSelected(),
    `the ${layout} layout was never chosen`,
  );
}

/** Waits until the map draws an edge for each relation. */
async function expectEdges(
  relations: [string, string, string][],
): Promise<void> {
  for (const [from, rel, to] of relations) {
    await edge(from, rel, to).waitForExist({
      timeout: 15000,
      timeoutMsg: `no ${rel} edge from ${from} to ${to}`,
    });
  }
}

/**
 * Whether the centre of each node's ring lies inside the Cluster-wide access box. One call
 * reads them all, so a refit cannot move the drawing between two of them.
 */
async function inAccessBox(ids: string[]): Promise<boolean[]> {
  return browser.execute((wanted: string[]) => {
    const box = document
      .querySelector('[data-testid="map-access"] > rect')
      ?.getBoundingClientRect();
    return wanted.map((id) => {
      const ring = document
        .querySelector(`[data-testid="map-node"][data-id="${id}"] circle`)
        ?.getBoundingClientRect();
      if (!box || !ring) return false;
      const x = ring.x + ring.width / 2;
      const y = ring.y + ring.height / 2;
      return x > box.left && x < box.right && y > box.top && y < box.bottom;
    });
  }, ids);
}

/**
 * Makes the page's save dialog answer `paths[‹extension›]`, by the extension of its one
 * filter, so an export writes there and no dialog opens. Tauri defines
 * `window.__TAURI_INTERNALS__.invoke` read-only, so this wraps the `fetch` through which it
 * sends each command to the app.
 */
async function answerSaveDialog(paths: Record<string, string>): Promise<void> {
  await browser.execute((answers: Record<string, string>) => {
    const { __TAURI_INTERNALS__: internals } = window as unknown as {
      __TAURI_INTERNALS__: {
        convertFileSrc(file: string, protocol: string): string;
      };
    };
    const save = internals.convertFileSrc("plugin:dialog|save", "ipc");
    const send = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input) !== save) return send(input, init);
      const { options } = JSON.parse(String(init?.body));
      const answer = answers[options.filters[0].extensions[0]] ?? null;
      return Promise.resolve(
        new Response(JSON.stringify(answer), {
          headers: {
            "Content-Type": "application/json",
            "Tauri-Response": "ok",
          },
        }),
      );
    };
  }, paths);
}

/** Picks an item of the toolbar's Export menu and waits for its toast. */
async function exportAs(format: "png" | "pdf", toast: string): Promise<void> {
  const button = await shown("map-export");
  await button.waitForEnabled({ timeout: 15000 });
  await pointerClick(button);
  await clickWhenShown(`map-export-${format}`);
  await gone(`map-export-${format}`);
  await expectToast(toast);
}

describe("resource map", () => {
  let pod = "";

  before(async () => {
    pod = (
      await kubectl([
        "-n",
        NS,
        "get",
        "pods",
        "-l",
        "app=web",
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ])
    ).trim();
    await openCluster(KIND);
  });

  it("draws the fixture's objects and relations from the sidebar", async () => {
    await clickWhenShown("nav-map");
    await shown("map-ns-filter", 60000);
    // Only the fixture's namespace stays shown, so the drawing stays small.
    await onlyNamespace(NS);
    for (const id of OBJECTS) {
      await node(id).waitForExist({
        timeout: 30000,
        timeoutMsg: `the map never drew ${id}`,
      });
    }
    // Grouped draws ownership as boxes, so the lines are read from Layered.
    await clickWhenShown("map-layout-layered");
    const relations: [string, string, string][] = [
      [DEPLOYMENT, "owns", REPLICA_SET],
      [REPLICA_SET, "owns", POD],
      [SERVICE, "selects", POD],
      [INGRESS, "routes", SERVICE],
      [GATEWAY, "routes", ROUTE],
      [ROUTE, "routes", SERVICE],
      [GATEWAY, "class", CLASS],
      [POD, "mounts", CONFIG],
      [POD, "env", SECRET],
      [POD, "runsAs", ACCOUNT],
      [POD, "claims", CLAIM],
    ];
    for (const [from, rel, to] of relations) {
      await edge(from, rel, to).waitForExist({
        timeout: 15000,
        timeoutMsg: `no ${rel} edge from ${from} to ${to}`,
      });
    }
  });

  it("fills the page under the toolbar", async () => {
    const canvas = await shown("map-canvas");
    const { height } = await canvas.getSize();
    const viewport = await browser.execute(() => window.innerHeight);
    // The toolbar, the filters row and window chrome take well under half of the window.
    expect(height).toBeGreaterThan(viewport / 2);
  });

  it("shows the Gateway and its class waiting for a controller", async () => {
    expect(await node(GATEWAY).getAttribute("data-status")).toBe("warning");
    await select(GATEWAY, "Gateway edge");
    await until(
      async () =>
        (await byTestId("map-details").getText()).includes(
          "Not programmed yet",
        ),
      "the Gateway never read Not programmed yet",
    );
    await select(CLASS, `GatewayClass ${NS}`);
    await until(
      async () =>
        (await byTestId("map-details").getText()).includes(
          "Waiting for the controller",
        ),
      "the GatewayClass never read Waiting for the controller",
    );
  });

  it("shows the Pod's facts and connections, and a row selects the Service", async () => {
    await select(POD, `Pod ${pod}`);
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="map-fact"]')).map(
        (el) => el.getAttribute("data-label"),
      ),
    );
    for (const label of ["Ready", "Restarts", "Node", "Age"]) {
      expect(labels).toContain(label);
    }
    const row = $(
      `[data-testid="map-connection"][data-id="${SERVICE}"][data-dir="in"]`,
    );
    await row.waitForExist({ timeout: 15000 });
    await row.click();
    await until(
      async () =>
        (await byTestId("map-details").getAttribute("aria-label")) ===
        "Service web",
      "the Service row never selected the Service",
    );
  });

  it("opens the Deployment's object map at 2 hops; 1 hop draws less; Back returns", async () => {
    await select(DEPLOYMENT, "Deployment web");
    await clickWhenShown("map-details-focus");
    await until(
      async () => (await focus()) === DEPLOYMENT,
      "the object map never opened",
    );
    expect(await (await byTestId("map-depth-2").$("input")).isSelected()).toBe(
      true,
    );
    await shown("map-summary");
    const twoHops = await summaryCount();
    await clickWhenShown("map-depth-1");
    await until(
      async () => (await summaryCount()) < twoHops,
      "1 hop never drew fewer resources",
    );
    await browser.back();
    await until(
      async () =>
        (await focus()) === null && (await byTestId("map-search").isExisting()),
      "Back never returned to the cluster map",
    );
  });

  it("draws the Pod drawer's Resource map, whose link opens the object map", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await searchResources(pod);
    await clickWhenShown(rowId(NS, pod));
    await shown("detail-drawer");
    await pointerClick(await shown("detail-tab-map"));
    await shown("drawer-map", 30000);
    await until(
      async () =>
        (await $$('[data-testid="drawer-map"] [data-testid="map-node"]').length) >
        0,
      "the drawer's map never drew",
    );
    await clickWhenShown("drawer-map-open");
    await until(
      async () => (await focus()) === `Pod/${NS}/${pod}`,
      "the drawer's link never opened the Pod's object map",
    );
  });

  it("says so when the only shown namespace is hidden", async () => {
    await clickWhenShown("nav-map");
    await openFilter("ns");
    await setBox(`map-ns-option-${NS}`, false);
    await until(
      async () =>
        (await byTestId("map-empty").isExisting()) &&
        (await byTestId("map-empty").getText()) ===
          "All namespaces are hidden. Pick one above to draw the map.",
      "hiding the last namespace never said so",
    );
    await setBox(`map-ns-option-${NS}`, true);
    await closeFilter("ns");
    await shown("map-canvas", 30000);
  });

  it("hides kinds and bridges their links", async () => {
    await clickWhenShown("nav-map");
    await node(DEPLOYMENT).waitForExist({ timeout: 30000 });
    // Bridges are read from Layered, which draws every edge as a line.
    await clickWhenShown("map-layout-layered");

    // 1. ReplicaSets hidden: the Deployment owns its Pod through one.
    await openFilter("kind");
    await setBox("map-kind-option-ReplicaSet", false);
    await closeFilter("kind");
    await node(REPLICA_SET).waitForExist({ timeout: 15000, reverse: true });
    const owns = edge(DEPLOYMENT, "owns", POD);
    await owns.waitForExist({
      timeout: 15000,
      timeoutMsg: "no bridge from the Deployment to its Pod",
    });
    expect(await owns.getAttribute("data-via")).toBe("ReplicaSet");
    await select(DEPLOYMENT, "Deployment web");
    const row = $(
      `[data-testid="map-connection"]${idMatch("data-id", POD)}[data-via="ReplicaSet"]`,
    );
    await row.waitForExist({
      timeout: 15000,
      timeoutMsg: "the details never listed the Pod via ReplicaSet",
    });
    expect(await row.getText()).toContain("via ReplicaSet");
    await clickWhenShown("map-details-close");

    // 2. Pods hidden too. The graph's use edges start at Pods, so neither bridge meets a real edge.
    await openFilter("kind");
    await setBox("map-kind-option-Pod", false);
    await closeFilter("kind");
    const selects = edge(SERVICE, "selects", DEPLOYMENT);
    await selects.waitForExist({
      timeout: 15000,
      timeoutMsg: "no bridge from the Service to the Deployment",
    });
    expect(await selects.getAttribute("data-via")).toBe("Pod,ReplicaSet");
    const mounts = edge(DEPLOYMENT, "mounts", CONFIG);
    await mounts.waitForExist({
      timeout: 15000,
      timeoutMsg: "no bridge from the Deployment to its ConfigMap",
    });
    expect(await mounts.getAttribute("data-via")).toBe("Pod,ReplicaSet");

    // 3. The legend names bridges while one is drawn.
    await clickWhenShown("map-legend-toggle");
    await shown("map-legend-bridge");
    await clickWhenShown("map-legend-toggle");

    // 4. Every kind hidden.
    await openFilter("kind");
    await clickWhenShown("map-kind-clear");
    await until(
      async () =>
        (await byTestId("map-empty").isExisting()) &&
        (await byTestId("map-empty").getText()) ===
          "All kinds are hidden. Pick one in Kinds to draw the map.",
      "hiding every kind never said so",
    );

    // 5. A Kinds choice is kept when the page is opened again.
    await clickWhenShown("map-kind-select-all");
    await setBox("map-kind-option-ReplicaSet", false);
    await closeFilter("kind");
    await openResource("nav-item-core-pods", "Pod");
    await clickWhenShown("nav-map");
    await until(
      async () =>
        (await byTestId("map-kind-filter").isExisting()) &&
        (await byTestId("map-kind-filter").getAttribute("title")) === "Hidden: ReplicaSets",
      "the Kinds choice was not kept",
    );
    await edge(DEPLOYMENT, "owns", POD).waitForExist({
      timeout: 30000,
      timeoutMsg: "the kept choice drew no bridge",
    });

    // 6. Clear filters brings everything back; then the fixture's namespace alone again.
    await clickWhenShown("map-clear-filters");
    await gone("map-clear-filters");
    expect(await byTestId("map-kind-filter").getText()).toBe("All kinds");
    expect(await byTestId("map-ns-filter").getText()).toBe("All namespaces");
    await node(REPLICA_SET).waitForExist({ timeout: 30000 });
    await onlyNamespace(NS);
  });

  it("dims what the search misses, and each layout draws the fixture", async () => {
    await node(SECRET).waitForExist({ timeout: 30000 });
    await (await shown("map-search")).setValue("web-secret");
    await until(
      async () => (await opacity(DEPLOYMENT)) < 1,
      "the search never dimmed the Deployment",
    );
    expect(await opacity(SECRET)).toBe(1);
    await (await shown("map-search")).clearValue();
    for (const layout of ["grouped", "layered", "force"]) {
      await clickWhenShown(`map-layout-${layout}`);
      await until(
        async () =>
          (await byTestId(`map-layout-${layout}`).$("input")).isSelected(),
        `the ${layout} layout was never chosen`,
      );
      for (const id of OBJECTS) {
        await node(id).waitForExist({
          timeout: 15000,
          timeoutMsg: `${layout} never drew ${id}`,
        });
      }
    }
  });

  it("links the ServiceAccount to its bindings and their roles, with the rules", async () => {
    await clickWhenShown("nav-map");
    await chooseLayout("layered");
    await expectEdges(ACCESS);
    await select(READER_ROLE, "Role web-config-reader");
    const rule = $('[data-testid="map-fact"][data-label="configmaps"]');
    await rule.waitForExist({
      timeout: 15000,
      timeoutMsg: "the Role's facts never listed its configmaps rule",
    });
    expect(await rule.$("dd").getText()).toBe("get, list");
    expect(await node(LEADER_ROLE).getAttribute("data-status")).toBe(
      "critical",
    );
    await select(LEADER_ROLE, "Role web-leader");
    await until(
      async () =>
        (await byTestId("map-details").getText()).includes("Not found"),
      "the missing Role never read Not found",
    );
    await clickWhenShown("map-details-close");
  });

  it("puts the ClusterRoleBinding and its ClusterRole in the Cluster-wide access box", async () => {
    await chooseLayout("grouped");
    await shown("map-access", 15000);
    await until(
      async () =>
        JSON.stringify(
          await inAccessBox([
            VIEW_BINDING,
            VIEW_ROLE,
            READER_BINDING,
            READER_ROLE,
          ]),
        ) === JSON.stringify([true, true, false, false]),
      "the Access box never held just the ClusterRoleBinding and its ClusterRole",
    );
  });

  it("shows the access chain on the Deployment's object map", async () => {
    // Grouped draws the Deployment as a box, and `select` clicks a node's ring.
    await chooseLayout("layered");
    await select(DEPLOYMENT, "Deployment web");
    await clickWhenShown("map-details-focus");
    await until(
      async () => (await focus()) === DEPLOYMENT,
      "the object map never opened",
    );
    await expectEdges(ACCESS);
    await browser.back();
    await until(
      async () =>
        (await focus()) === null && (await byTestId("map-search").isExisting()),
      "Back never returned to the cluster map",
    );
  });

  it("exports the map as a PNG image and a PDF document", async () => {
    fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    await chooseLayout("grouped");
    await shown("map-access", 15000);
    await answerSaveDialog(EXPORTS);
    await exportAs("png", "Map exported as PNG");
    expect(fs.readFileSync(EXPORTS.png).subarray(0, 4).toString("latin1")).toBe(
      "\x89PNG",
    );
    await exportAs("pdf", "Map exported as PDF");
    expect(fs.readFileSync(EXPORTS.pdf).subarray(0, 5).toString("latin1")).toBe(
      "%PDF-",
    );
    fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  });

  it("lists the Gateway's class and the HTTPRoute's parents", async () => {
    await openResource(`nav-item-${GATEWAY_GROUP}-gateways`, "Gateway");
    await until(
      async () => (await tableHeaders()).includes("Programmed"),
      "the Gateways list never showed its columns",
    );
    // The namespace and the class have the same name: the row shows it twice.
    await until(
      async () =>
        (await (await shown(rowId(NS, "edge"))).getText()).split(NS).length >=
        3,
      "the Gateway row never showed its class",
    );
    await openResource(`nav-item-${GATEWAY_GROUP}-httproutes`, "HTTPRoute");
    await until(
      async () =>
        (await (await shown(rowId(NS, "web"))).getText()).includes(
          `${NS}/edge`,
        ),
      "the HTTPRoute row never showed its parent",
    );
  });

  it("puts Helm and Argo CD under Nodes, and every Gateway API kind under Network", async () => {
    const sections = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[data-testid^="nav-section-"]')).map(
          (s) => s.getAttribute("data-testid") ?? "",
        ),
      );
    await until(
      async () =>
        (await sections()).slice(0, 4).join(" ") ===
        "nav-section-nodes nav-section-helm nav-section-argocd nav-section-workloads",
      "the sidebar never started with Nodes, Helm, Argo CD and Workloads",
    );
    for (const plural of NETWORK_GATEWAY_KINDS) {
      await byTestId(`nav-item-${GATEWAY_GROUP}-${plural}`).waitForExist({
        timeout: 30000,
        timeoutMsg: `Network never listed ${plural}`,
      });
    }
    // Opens the k8s.io domain of Custom Resources, if it has one, to look inside it.
    const domain = byTestId("nav-crd-domain-toggle-k8s.io");
    if (
      (await domain.isExisting()) &&
      (await domain.getAttribute("aria-expanded")) !== "true"
    ) {
      await domain.click();
    }
    const placed = await browser.execute((group: string) => {
      return Array.from(
        document.querySelectorAll(`[data-testid^="nav-item-${group}-"]`),
      ).map((item) => [
        (item.getAttribute("data-testid") ?? "").slice(
          `nav-item-${group}-`.length,
        ),
        item.closest('[data-testid^="nav-section-"]')?.getAttribute("data-testid") ??
          "",
      ]);
    }, GATEWAY_GROUP);
    expect(placed.map(([, section]) => section)).toEqual(
      placed.map(() => "nav-section-network"),
    );
    expect(
      placed
        .map(([plural]) => plural)
        .filter((plural) => NETWORK_GATEWAY_KINDS.includes(plural)),
    ).toEqual(NETWORK_GATEWAY_KINDS);
    expect(
      await byTestId(`nav-crd-group-${GATEWAY_GROUP}`).isExisting(),
    ).toBe(false);
  });

  it("finds the Pod by an annotation picked from the suggestions, shows its chip, and every Pod again without the token", async () => {
    await kubectl([
      "-n",
      NS,
      "annotate",
      "pod",
      pod,
      `${FILTER_KEY}=${FILTER_VALUE}`,
      "--overwrite",
    ]);
    // Every namespace's Pods, so the filter visibly narrows the list.
    await openResource("nav-item-core-pods", "Pod");
    await expectRows("the kube-system pods and the fixture's Pod", (ids) =>
      ids.includes(rowId(NS, pod)) &&
      ids.some((id) => id.startsWith("resource-row-kube-system-")),
    );

    await (await shown("resource-search")).setValue("anno:skopos");
    await pickFilterSuggestion(`anno:${FILTER_KEY}`);
    await pickFilterSuggestion("=");
    await pickFilterSuggestion(FILTER_VALUE);
    await expectRowsExactly([rowId(NS, pod)]);
    await browser.keys("Escape");
    await gone("filter-suggestions");

    expect(await byTestId("filter-token-edit-0").getAttribute("aria-label")).toBe(
      `Edit filter anno:${FILTER_KEY} = ${FILTER_VALUE}`,
    );
    const chip = (await shown(rowId(NS, pod))).$('[data-testid="filter-chip"]');
    await chip.waitForExist({ timeout: 15000 });
    expect(await chip.getAttribute("title")).toBe(
      `anno ${FILTER_KEY}=${FILTER_VALUE}`,
    );

    await clickWhenShown("filter-token-remove-0");
    await gone("filter-tokens");
    await expectRows("every Pod again", (ids) =>
      ids.includes(rowId(NS, pod)) &&
      ids.some((id) => id.startsWith("resource-row-kube-system-")),
    );
  });
});
