import fs from "node:fs";
import path from "node:path";
import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId,
  clickNav,
  clickWhenShown,
  expectResourceTitle,
  expectRows,
  gone,
  openCluster,
  openResource,
  shown,
  toggleInCheckMenu,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
// The section overviews spec uses the same namespace and fixture, one spec after the other.
const NS = "skopos-test-sections";
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "sections.yaml");
const PODS = "nav-item-core-pods";
// The worktree's git-ignored tmp/, two levels up from e2e/specs.
const OUT = path.resolve(__dirname, "../../tmp/screens");
/** The tiles of Workloads by kind, in their order (spec §3.2). */
const KINDS = [
  "pods",
  "deployments",
  "daemonsets",
  "statefulsets",
  "replicasets",
  "jobs",
  "cronjobs",
];

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
  const opener = await until(() => openerOf(table, pick), `${table} never showed the row to open`);
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

/**
 * The first Recent events row that opens its object: the opener's test id, the object's
 * name and its kind, read from the `<kind> · <reason>` line under the name.
 */
function firstEventObject(): Promise<{ id: string; name: string; kind: string } | null> {
  return browser.execute(() => {
    for (const row of Array.from(
      document.querySelectorAll('[data-testid^="workloads-events-row-"]'),
    )) {
      const opener = row.querySelector('[data-testid^="workloads-events-open-"]');
      const id = opener?.getAttribute("data-testid");
      if (!opener || !id) continue;
      let cell: Element = opener;
      while (cell.parentElement !== null && cell.parentElement !== row) cell = cell.parentElement;
      const name = (opener.textContent ?? "").trim();
      const sub = (cell.textContent ?? "").trim().slice(name.length).trim();
      return { id, name, kind: sub.split(" · ")[0] ?? "" };
    }
    return null;
  });
}

describe("the Workloads overview", () => {
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

  it("counts every kind of the cluster as a tile, in order, and a tile opens its list", async () => {
    await clickNav("nav-overview-workloads");
    expect(await (await shown("workloads-overview-title")).getText()).toBe("Workloads overview");
    expect(await byTestId("workloads-overview-namespaces").isExisting()).toBe(false);
    const tiles = await until(async () => {
      const ids = await browser.execute(() =>
        Array.from(
          document.querySelectorAll(
            '[data-testid="workloads-overview-card-kinds"] [data-testid^="overview-tile-"]',
          ),
        )
          .map((tile) => tile.getAttribute("data-testid") ?? "")
          .filter((id) => /^overview-tile-[a-z]+$/.test(id)),
      );
      return ids.length === KINDS.length ? ids : false;
    }, "Workloads by kind never showed its seven tiles");
    expect(tiles).toEqual(KINDS.map((kind) => `overview-tile-${kind}`));
    // Other specs start and stop Pods, so compare with a fresh count on every try.
    for (const kind of ["pods", "deployments"]) {
      await until(
        async () =>
          (await textsOf([`overview-tile-${kind}-number`]))[0] ===
          (await countOf(["get", kind, "--all-namespaces"])).toLocaleString("en-US"),
        `the ${kind} tile never matched the number kubectl lists`,
      );
    }
    // The fixture's broken Pod never pulls its image, so the cluster has a failing Pod.
    await until(
      async () =>
        /^[1-9][\d,]* failing( · [\d,]+ pending)?$/.test(
          (await textsOf(["overview-tile-pods-sub"]))[0] ?? "",
        ),
      "the Pods tile never counted the failing Pod",
    );
    await clickWhenShown("overview-tile-deployments");
    await expectResourceTitle("Deployment");
  });

  it("follows the namespace chosen in the lists: its tiles, Health and the problems, failing first", async () => {
    await openResource(PODS, "Pod");
    await toggleInCheckMenu("namespace-filter", [`namespace-option-${NS}`]);
    expect(await byTestId("namespace-filter").getText()).toBe(NS);
    await clickNav("nav-overview-workloads");
    await until(
      async () => (await textsOf(["workloads-overview-namespaces"]))[0] === `Namespaces: ${NS}`,
      "the page never named the chosen namespace",
    );
    // The broken Pod fails; its Deployment and ReplicaSet wait for it, so they are pending.
    await expectTiles([
      ["pods", "2", "1 failing"],
      ["deployments", "2", "1 pending"],
      ["daemonsets", "0", "None"],
      ["statefulsets", "0", "None"],
      ["replicasets", "2", "1 pending"],
      ["jobs", "0", "None"],
      ["cronjobs", "0", "None"],
    ]);
    // Healthy is all minus pending minus failing: 6 objects, 2 pending and 1 failing.
    await until(async () => {
      const [values, note] = await textsOf([
        "overview-capacity-healthy-values",
        "overview-capacity-healthy-note",
      ]);
      return /^3 \/ 6\b/.test(values ?? "") && note === "2 pending · 1 failing";
    }, "Health never showed 3 of 6 workloads healthy");
    await rowsOf("workloads-health", KINDS.length);
    const problems = await rowsOf("workloads-problems", 3);
    expect(problems[0]).toMatch(/ErrImagePull|ImagePullBackOff/);

    fs.mkdirSync(OUT, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await browser.execute((t: string) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await browser.pause(300);
      await browser.saveScreenshot(path.join(OUT, `workloads-overview-${theme}.png`));
    }

    await openInDrawer("workloads-problems", { name: "broken", parts: ["Deployment"] }, "Deployment");
    await closeDrawer("workloads-overview");
  });

  it("lists the namespace's newest events, and an event opens its object", async () => {
    await until(async () => {
      const count = (await rowTexts("workloads-events")).length;
      return count >= 1 && count <= 8;
    }, "Recent events never listed the namespace's events");
    const event = await until(firstEventObject, "no recent event opens its object");
    await (await shown(event.id)).click();
    await shown("detail-drawer");
    await drawerShows(event.kind, event.name);
    await closeDrawer("workloads-overview");
  });

  it("opens the Pods list from its tile, under the same namespace", async () => {
    await clickWhenShown("overview-tile-pods");
    await expectResourceTitle("Pod");
    await expectRows(
      `the two Pods of ${NS}`,
      (ids) => ids.length === 2 && ids.every((id) => id.startsWith(`resource-row-${NS}-`)),
    );
  });
});
