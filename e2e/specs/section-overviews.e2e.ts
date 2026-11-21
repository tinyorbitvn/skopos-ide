import path from "node:path";
import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId,
  clickNav,
  clickWhenShown,
  gone,
  openCluster,
  openResource,
  shown,
  toggleInCheckMenu,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
// The Workloads overview spec uses the same namespace and fixture, one spec after the other.
const NS = "skopos-test-sections";
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "sections.yaml");
const PODS = "nav-item-core-pods";

interface Page {
  id: string;
  title: string;
}

/** The five pages, in the sidebar's order (spec §3.7). */
const PAGES: Page[] = [
  { id: "nodes", title: "Nodes overview" },
  { id: "namespaces", title: "Namespaces overview" },
  { id: "workloads", title: "Workloads overview" },
  { id: "network", title: "Network overview" },
  { id: "storage", title: "Storage overview" },
];

/** Each node's name, Ready, cordon and `status.nodeInfo` fields, tab-separated, a line per node. */
const NODE_FIELDS =
  '{range .items[*]}{.metadata.name}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\t"}{.spec.unschedulable}{"\\t"}{.status.nodeInfo.kubeletVersion}{"\\t"}{.status.nodeInfo.osImage}{"\\t"}{.status.nodeInfo.architecture}{"\\n"}{end}';

interface NodeFacts {
  name: string;
  ready: boolean;
  cordoned: boolean;
  kubelet: string;
  osImage: string;
  architecture: string;
}

/** Waits until `check` gives a truthy value, and gives that value. */
function until<T>(check: () => Promise<T>, timeoutMsg: string, timeout = 60000) {
  return browser.waitUntil(check, { timeout, interval: 500, timeoutMsg });
}

/**
 * The trimmed text of each test id, null where it is missing, read in one script:
 * WebKitWebDriver mixes up two getText calls in a row.
 */
function textsOf(ids: string[]): Promise<(string | null)[]> {
  return browser.execute(
    (list: string[]) =>
      list.map((id) => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        return element === null ? null : (element.textContent ?? "").trim();
      }),
    ids,
  );
}

/** How many objects kubectl lists for these arguments. */
async function countOf(args: string[]): Promise<number> {
  const out = await kubectl([...args, "-o", "name"]);
  return out.split("\n").filter((line) => line.trim() !== "").length;
}

/** The nodes as kubectl lists them, by name. */
async function nodeFacts(): Promise<NodeFacts[]> {
  const out = await kubectl(["get", "nodes", "-o", `jsonpath=${NODE_FIELDS}`]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name = "", ready = "", unschedulable = "", kubelet = "", osImage = "", architecture = ""] =
        line.split("\t");
      return {
        name,
        ready: ready === "True",
        cordoned: unschedulable === "true",
        kubelet,
        osImage,
        architecture,
      };
    });
}

/** `1 node`, `2 nodes`, with thousands commas (spec §3.1). */
function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : `${word}s`}`;
}

/** A tile's names: up to two, then `and N more` (spec §3.1); `None` without any. */
function names(list: string[]): string {
  if (list.length === 0) return "None";
  if (list.length <= 2) return list.join(", ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

/** Waits until each tile reads `[id, number, sub]`, and names what they read when they never do. */
async function expectTiles(expected: [string, string, string][]): Promise<void> {
  const want = expected.map(([id, number, sub]) => `${id}: ${number} / ${sub}`);
  let seen: string[] = [];
  await browser
    .waitUntil(
      async () => {
        const texts = await textsOf(
          expected.flatMap(([id]) => [`overview-tile-${id}-number`, `overview-tile-${id}-sub`]),
        );
        seen = expected.map(([id], i) => `${id}: ${texts[2 * i]} / ${texts[2 * i + 1]}`);
        return seen.every((line, i) => line === want[i]);
      },
      { timeout: 60000, interval: 500 },
    )
    .catch(() => {
      throw new Error(`the tiles never read ${want.join("; ")}; they read ${seen.join("; ")}`);
    });
}

/** The text of each row of an overview table, top to bottom. */
function rowTexts(table: string): Promise<string[]> {
  return browser.execute(
    (id: string) =>
      Array.from(document.querySelectorAll(`[data-testid^="${id}-row-"]`)).map((row) =>
        (row.textContent ?? "").trim(),
      ),
    table,
  );
}

/** Waits until an overview table holds `count` rows, and gives their texts. */
function rowsOf(table: string, count: number): Promise<string[]> {
  return until(async () => {
    const rows = await rowTexts(table);
    return rows.length === count ? rows : false;
  }, `${table} never held ${count} rows`);
}

/** The screen-reader names of the donuts in an overview table's rows, in order. */
function donutLabels(table: string): Promise<string[]> {
  return browser.execute(
    (id: string) =>
      Array.from(
        document.querySelectorAll(`[data-testid^="${id}-row-"] [role="img"][aria-label]`),
      ).map((donut) => donut.getAttribute("aria-label") ?? ""),
    table,
  );
}

/** Which row of a table to pick: by its name, the opener's text, and by texts it holds. */
interface RowPick {
  name?: string;
  parts?: string[];
}

/** The test id of the opener of the first row of `table` that `pick` matches, or null. */
function openerOf(table: string, pick: RowPick = {}): Promise<string | null> {
  return browser.execute(
    (id: string, want: RowPick) => {
      for (const row of Array.from(document.querySelectorAll(`[data-testid^="${id}-row-"]`))) {
        const opener = row.querySelector(`[data-testid^="${id}-open-"]`);
        if (opener === null) continue;
        const text = row.textContent ?? "";
        if (want.name !== undefined && (opener.textContent ?? "").trim() !== want.name) continue;
        if (!(want.parts ?? []).every((part) => text.includes(part))) continue;
        return opener.getAttribute("data-testid");
      }
      return null;
    },
    table,
    pick,
  );
}

/** Waits until a row `pick` matches shows, and gives its opener's test id. */
function rowShown(table: string, pick: RowPick, what: string): Promise<string> {
  return until(() => openerOf(table, pick), `${table} never showed ${what}`);
}

/** Waits until the drawer's band shows `kind` and `title`. */
async function drawerShows(kind: string, title: string): Promise<void> {
  let seen = "nothing";
  await browser
    .waitUntil(
      async () => {
        const [kindText, titleText] = await textsOf(["detail-kind", "detail-title"]);
        seen = `${kindText} / ${titleText}`;
        return kindText === kind && titleText === title;
      },
      { timeout: 30000, interval: 250 },
    )
    .catch(() => {
      throw new Error(`the drawer never showed ${kind} ${title}; it showed ${seen}`);
    });
}

/** Opens the object of the first row `pick` matches; the drawer's title is the row's name unless given. */
async function openInDrawer(
  table: string,
  pick: RowPick,
  kind: string,
  title?: string,
): Promise<void> {
  const opener = await rowShown(table, pick, "the row to open");
  const [name] = await textsOf([opener]);
  await (await shown(opener)).click();
  await shown("detail-drawer");
  await drawerShows(kind, title ?? name ?? "");
}

/** Closes the drawer, back on the page whose test id is `page`. */
async function closeDrawer(page: string): Promise<void> {
  await clickWhenShown("detail-close");
  await gone("detail-drawer");
  await shown(`${page}-title`);
}

/** The selected tab's name, `<screen> · <cluster>`. */
function selectedTab(): Promise<string | null> {
  return browser.execute(
    () =>
      document
        .querySelector('[role="presentation"][data-selected="true"] [role="tab"]')
        ?.getAttribute("aria-label") ?? null,
  );
}

/** Waits for the page's title, and for its tab to read `<page title> · <cluster>` (spec §3.7). */
async function expectPage(page: Page): Promise<void> {
  await until(
    async () =>
      (await textsOf([`${page.id}-overview-title`]))[0] === page.title &&
      ((await selectedTab()) ?? "").startsWith(`${page.title} · ${KIND}`),
    `the ${page.title} never showed in its tab`,
  );
}

/** Goes to the cluster's Overview, so that the next open is a navigation of its own. */
async function leave(): Promise<void> {
  await clickNav("nav-overview");
  await shown("overview-grid", 30000);
}

/** Types `query` in the palette and clicks the row `row`, which runs it. */
async function fromPalette(query: string, row: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  await (await shown("palette-input")).setValue(query);
  await clickWhenShown(row);
  await gone("palette");
}

describe("the section overviews", () => {
  before(async function () {
    this.timeout(300000);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", FIXTURE]);
    await kubectl(["-n", NS, "rollout", "status", "deployment/mounted", "--timeout=180s"]);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("opens each page from the sidebar, the palette's pages and its command, named in its tab", async function () {
    this.timeout(300000);
    for (const page of PAGES) {
      await clickNav(`nav-overview-${page.id}`);
      await expectPage(page);
      // No namespace is chosen yet, so no page names any.
      expect(await byTestId(`${page.id}-overview-namespaces`).isExisting()).toBe(false);
      await leave();

      await fromPalette(page.title, `palette-page-${page.id}`);
      await expectPage(page);
      await leave();

      await fromPalette(`${page.title} of`, `palette-command-${page.id}-overview`);
      await expectPage(page);
      await leave();
    }
  });

  it("shows the kind nodes by state, their capacity, zones and versions, and the busiest ones", async () => {
    await clickNav("nav-overview-nodes");
    await shown("nodes-overview-title");
    const nodes = await nodeFacts();
    const ready = nodes.filter((node) => node.ready).length;
    // The kind nodes are under no pressure.
    await expectTiles([
      ["ready", String(ready), `Of ${plural(nodes.length, "node")}`],
      ["not-ready", String(nodes.length - ready), names(nodes.filter((n) => !n.ready).map((n) => n.name))],
      ["cordoned", String(nodes.filter((n) => n.cordoned).length), names(nodes.filter((n) => n.cordoned).map((n) => n.name))],
      ["pressure", "0", "None"],
    ]);
    // Without metrics-server the donuts show the Pods' requests, in the same units.
    await until(async () => {
      const [cpu, memory, pods] = await textsOf([
        "overview-capacity-cpu-values",
        "overview-capacity-memory-values",
        "overview-capacity-pods-values",
      ]);
      return (
        /^\d+(\.\d)? \/ \d+(\.\d)? cores$/.test(cpu ?? "") &&
        /^\d+(\.\d)? \/ \d+(\.\d)? (GiB|MiB)$/.test(memory ?? "") &&
        /^\d+ \/ \d+ pods$/.test(pods ?? "")
      );
    }, "the Capacity donuts never showed numbers");

    // The control plane has no zone label, so No zone is the last row.
    const zones = await until(async () => {
      const rows = await rowTexts("nodes-zones");
      return rows.length > 0 ? rows : false;
    }, "By zone never listed a zone");
    expect(zones[zones.length - 1]).toMatch(/^No zone/);
    const zone = await rowShown("nodes-zones", { parts: ["No zone"] }, "a link on No zone");
    await (await shown(zone)).click();
    await shown("topology-page", 30000);
    await clickNav("nav-overview-nodes");
    await shown("nodes-overview-title");

    const distinct = (values: string[]) => new Set(values).size;
    await until(
      async () =>
        (await rowTexts("nodes-kubelets")).length === distinct(nodes.map((n) => n.kubelet)) &&
        (await rowTexts("nodes-os-images")).length === distinct(nodes.map((n) => n.osImage)) &&
        (await rowTexts("nodes-architectures")).length ===
          distinct(nodes.map((n) => n.architecture)),
      "the Versions tables never listed each distinct value once",
    );
    for (const row of await rowTexts("nodes-kubelets")) {
      expect(row).toMatch(/Same as the API server|API server v/);
    }

    const busiest = await until(async () => {
      if ((await rowTexts("nodes-busiest")).length > 0) return "rows";
      const [card] = await textsOf(["nodes-overview-card-busiest"]);
      return card?.includes("Busiest nodes need metrics-server") ? "no metrics" : false;
    }, "Busiest nodes never showed nodes or the metrics-server note");
    if (busiest === "rows") {
      await openInDrawer("nodes-busiest", {}, "Node");
      await closeDrawer("nodes-overview");
    }
  });

  it("names the namespace chosen in the lists on every page but Nodes", async () => {
    await openResource(PODS, "Pod");
    await toggleInCheckMenu("namespace-filter", [`namespace-option-${NS}`]);
    expect(await byTestId("namespace-filter").getText()).toBe(NS);
    for (const page of PAGES) {
      await clickNav(`nav-overview-${page.id}`);
      await shown(`${page.id}-overview-title`);
      if (page.id === "nodes") {
        // Nodes are cluster-scoped: the page names no namespace.
        expect(await byTestId("nodes-overview-namespaces").isExisting()).toBe(false);
      } else {
        await until(
          async () => (await textsOf([`${page.id}-overview-namespaces`]))[0] === `Namespaces: ${NS}`,
          `the ${page.title} never named ${NS}`,
        );
      }
    }
  });

  it("shows every namespace, the fixture's quota as donuts and its namespace's row", async () => {
    await clickNav("nav-overview-namespaces");
    await shown("namespaces-overview-title");
    // The Namespaces tile counts every namespace, whatever the selection.
    await until(async () => {
      const [number, sub] = await textsOf([
        "overview-tile-namespaces-number",
        "overview-tile-namespaces-sub",
      ]);
      return (
        number === (await countOf(["get", "namespaces"])).toLocaleString("en-US") &&
        /^[\d,]+ Active( · [\d,]+ Terminating)?$/.test(sub ?? "")
      );
    }, "the Namespaces tile never matched the number kubectl lists");
    await expectTiles([
      ["quota", "1", "1 ResourceQuota"],
      ["limits", "0", "0 LimitRanges"],
    ]);

    // The quota sets cpu and memory, which count as requests.cpu and requests.memory.
    const quota = [
      new RegExp(`^${NS}/compute requests\\.cpu \\d+%, [\\d.]+ of 2 cores$`),
      new RegExp(`^${NS}/compute requests\\.memory \\d+%, [\\d.,]+ of (2 GiB|2,048 MiB)$`),
      new RegExp(`^${NS}/compute pods \\d+%, \\d+ of 10 pods$`),
    ];
    let labels: string[] = [];
    await browser
      .waitUntil(
        async () => {
          labels = await donutLabels("namespaces-quotas");
          return labels.length === quota.length && quota.every((re, i) => re.test(labels[i] ?? ""));
        },
        { timeout: 60000, interval: 500 },
      )
      .catch(() => {
        throw new Error(`Quota usage never showed the quota's donuts; it shows ${labels.join("; ")}`);
      });
    await rowsOf("namespaces-quotas", 1);

    const [own] = await rowsOf("namespaces-per-namespace", 1);
    expect(own).toMatch(new RegExp(`^${NS}`));

    await until(async () => {
      if ((await rowTexts("namespaces-top")).length > 0) return true;
      if (await byTestId("namespaces-top-empty").isExisting()) return true;
      const [card] = await textsOf(["namespaces-overview-card-top"]);
      return card?.includes("Top namespaces need metrics-server") === true;
    }, "Top namespaces never showed rows, its empty state or the metrics-server note");

    await openInDrawer("namespaces-quotas", { name: "compute" }, "ResourceQuota");
    await closeDrawer("namespaces-overview");
  });

  it("counts the fixture's Services and Ingress, and lists its dark Service, host and load balancer", async () => {
    await clickNav("nav-overview-network");
    await shown("network-overview-title");
    await expectTiles([
      ["cluster-ip", "1", "Reached inside the cluster"],
      ["node-port", "0", "None"],
      ["load-balancer", "1", "1 Pending"],
      ["external-name", "0", "None"],
      ["ingresses", "1", "1 without an address"],
      ["policies", "0", "None, so all traffic is allowed"],
    ]);
    // The map spec installs the Gateway API CRDs; without them the tile says so.
    await until(async () => {
      const [number, sub] = await textsOf([
        "overview-tile-gateways-number",
        "overview-tile-gateways-sub",
      ]);
      return (
        (number === "—" && sub === "Gateway API is not installed") ||
        (number === "0" && sub === "0 routes")
      );
    }, "the Gateways tile never read 0 routes or Gateway API is not installed");

    // lb's Pod is ready and dark has none: 1 of 1 endpoints ready.
    const slices = await countOf(["-n", NS, "get", "endpointslices"]);
    await until(async () => {
      const [values, note] = await textsOf([
        "overview-capacity-endpoints-values",
        "overview-capacity-endpoints-note",
      ]);
      return /^1 \/ 1\b/.test(values ?? "") && note === plural(slices, "EndpointSlice");
    }, "Endpoints ready never showed 1 of 1 endpoints ready");

    await rowsOf("network-dark-services", 1);
    await rowShown("network-dark-services", { name: "dark", parts: ["ClusterIP", "None"] }, "dark");
    await rowsOf("network-routes", 1);
    await rowShown(
      "network-routes",
      { name: "sections.skopos.test", parts: [`Ingress ${NS}/site`, "dark:80"] },
      "the Ingress's host",
    );
    await rowsOf("network-load-balancers", 1);
    await openInDrawer("network-load-balancers", { name: "lb", parts: ["Pending"] }, "Service");
    await closeDrawer("network-overview");

    // A host's row opens its Ingress, whose name differs from the host.
    await openInDrawer("network-routes", { name: "sections.skopos.test" }, "Ingress", "site");
    await closeDrawer("network-overview");
  });

  it("counts the fixture's claims, says why one is not Bound and shows the default class", async () => {
    await clickNav("nav-overview-storage");
    await shown("storage-overview-title");
    await expectTiles([
      ["bound", "1", `Of ${plural(2, "claim")}`],
      ["pending", "1", "unbound"],
      ["lost", "0", "None"],
      [
        "classes",
        (await countOf(["get", "storageclasses"])).toLocaleString("en-US"),
        "Default: standard",
      ],
    ]);

    await rowsOf("storage-unbound", 1);
    await rowShown(
      "storage-unbound",
      { name: "unbound", parts: ["Pending", "Waiting for a matching PersistentVolume"] },
      "why unbound is Pending",
    );

    const provisioner = (
      await kubectl(["get", "storageclass", "standard", "-o", "jsonpath={.provisioner}"])
    ).trim();
    const expansion =
      (
        await kubectl(["get", "storageclass", "standard", "-o", "jsonpath={.allowVolumeExpansion}"])
      ).trim() === "true"
        ? "Allowed"
        : "Not allowed";
    await rowShown(
      "storage-classes",
      { name: "standard", parts: ["Default", provisioner, expansion] },
      "the default class standard",
    );

    // The kubelet reports a claim's bytes only for some volume plugins, so either state is right.
    await until(async () => {
      if ((await openerOf("storage-claims", { name: "data" })) !== null) return true;
      const [card] = await textsOf(["storage-overview-card-claims"]);
      return card?.includes("No mounted claims") === true;
    }, "Largest claims never showed the mounted claim or No mounted claims");

    await openInDrawer("storage-unbound", { name: "unbound" }, "PersistentVolumeClaim");
    await closeDrawer("storage-overview");
  });
});
