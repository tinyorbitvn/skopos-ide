import { centre, dragTo } from "../helpers/tabs";
import {
  byTestId,
  catalogRow,
  clickWhenShown,
  dialogButton,
  gone,
  pointerClick,
  shown,
} from "../helpers/ui";
import { invoke } from "../helpers/windows";

interface Folders {
  folders: { id: string; name: string; parent: string | null }[];
  placements: Record<string, string>;
}

const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 15000, interval: 250, timeoutMsg });

async function folders(): Promise<Folders> {
  return invoke<Folders>("catalog_folders");
}

/** Types a folder's name into the field a new folder or Rename opens, and presses Enter. */
async function typeName(name: string): Promise<void> {
  await shown("catalog-folder-rename");
  // The field takes the focus and selects its text a moment after it shows.
  await until(
    () =>
      browser.execute(
        () => document.activeElement?.getAttribute("data-testid") === "catalog-folder-rename",
      ),
    "the name field never took the focus",
  );
  await browser.keys(Array.from(name));
  await browser.keys("Enter");
}

async function folderMenu(id: string, item: string): Promise<void> {
  await pointerClick(await shown(`catalog-folder-menu-${id}`));
  await clickWhenShown(`menu-item-${item}`);
}

async function level(id: string): Promise<string | null> {
  return byTestId(id).getAttribute("aria-level");
}

// Spec P47: catalog folders.
describe("catalog folders", () => {
  it("adds a folder at the top level and names it in place", async () => {
    await shown("catalog-row-alpha", 30000);

    await clickWhenShown("catalog-new-folder");
    await typeName("prod");

    await gone("catalog-folder-rename");
    expect(await (await shown("catalog-folder-folder-1")).getText()).toContain("prod");
    expect(await folders()).toEqual({
      folders: [{ id: "folder-1", name: "prod", parent: null }],
      placements: {},
    });
  });

  it("nests a subfolder from the folder's menu", async () => {
    await folderMenu("folder-1", "new-subfolder");
    await typeName("eu");

    await gone("catalog-folder-rename");
    expect(await (await shown("catalog-folder-folder-2")).getText()).toContain("eu");
    expect(await level("catalog-folder-folder-2")).toBe("2");
    expect((await folders()).folders[1]).toEqual({ id: "folder-2", name: "eu", parent: "folder-1" });
  });

  it("drags a cluster onto a folder", async () => {
    // The "Top level" strip lies over the table head while a drag is on, so no row moves:
    // eu is where it was before the drag started (P29).
    const eu = await centre(await shown("catalog-folder-folder-2"));

    await dragTo(await catalogRow("alpha"), eu);

    await until(async () => (await level("catalog-row-alpha")) === "3", "alpha never moved into eu");
    expect(Object.values((await folders()).placements)).toEqual(["folder-2"]);
    expect(await byTestId("catalog-folder-count-folder-1").getText()).toBe("1");
    expect(await byTestId("catalog-folder-count-folder-2").getText()).toBe("1");
    await gone("catalog-drag-label");
  });

  it("moves a cluster into a folder with Move to", async () => {
    await pointerClick(await shown("catalog-menu-beta"));
    await clickWhenShown("menu-item-move");
    await clickWhenShown("menu-item-move-folder-1");

    await until(async () => (await level("catalog-row-beta")) === "2", "beta never moved into prod");
    expect(await byTestId("catalog-folder-count-folder-1").getText()).toBe("2");
  });

  it("shows the core's refusal under the name, and Esc keeps the old name", async () => {
    await clickWhenShown("catalog-new-folder");
    await typeName("PROD");

    const error = await shown("catalog-folder-rename-error");
    expect(await error.getText()).toBe("PROD already exists here.");
    await browser.keys("Escape");
    await gone("catalog-folder-rename");
    expect(await byTestId("catalog-folder-folder-3").getText()).toContain("New folder");

    // An empty folder goes without asking.
    await folderMenu("folder-3", "delete");
    await gone("catalog-folder-folder-3");
    expect((await folders()).folders.map((f) => f.name)).toEqual(["prod", "eu"]);
  });

  it("finds clusters by their folder path", async () => {
    const search = await shown("catalog-search");
    await search.setValue("prod/eu");

    await gone("catalog-row-beta");
    await gone("catalog-row-gamma");
    await shown("catalog-row-alpha");
    await shown("catalog-folder-folder-1");
    await shown("catalog-folder-folder-2");

    await search.clearValue();
    await shown("catalog-row-gamma");
  });

  it("deletes a folder after asking, moving its cluster and subfolder up", async () => {
    await folderMenu("folder-1", "delete");

    const dialog = await shown("catalog-folder-delete-dialog");
    expect(await dialog.getText()).toContain(
      "Delete prod? Its 1 cluster and 1 folder move to Top level.",
    );
    await dialogButton("Delete").click();

    await gone("catalog-folder-folder-1");
    await until(async () => (await level("catalog-folder-folder-2")) === "1", "eu never moved up");
    expect(await level("catalog-row-beta")).toBe("1");
    expect(await level("catalog-row-alpha")).toBe("2");
    const after = await folders();
    expect(after.folders).toEqual([{ id: "folder-2", name: "eu", parent: null }]);
    expect(Object.values(after.placements)).toEqual(["folder-2"]);
  });

  it("shows a cluster's folder path in the palette", async () => {
    await browser.keys(["Control", "Shift", "p"]);
    await (await shown("palette-input")).setValue("eu alpha");

    await until(
      () =>
        browser.execute(() =>
          Array.from(document.querySelectorAll('[data-testid^="palette-cluster-"]')).some((row) =>
            (row.textContent ?? "").includes("eu / alpha"),
          ),
        ),
      "the palette never showed eu / alpha",
    );
    await browser.keys("Escape");
    await gone("palette");
  });
});
