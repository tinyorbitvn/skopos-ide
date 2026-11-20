import fs from "node:fs";
import path from "node:path";
import { clickWhenShown, dialogButton, gone, shown } from "../helpers/ui";

const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 30000, interval: 250, timeoutMsg });

/** Opens the palette, waits until `row` is selected for `query`, and runs it. */
async function runFromPalette(query: string, row: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  await (await shown("palette-input")).setValue(query);
  await until(async () => {
    const selected = browser.$('[data-testid="palette"] [aria-selected="true"]');
    return (
      (await selected.isExisting()) &&
      (await selected.getAttribute("data-testid")) === row
    );
  }, `the palette never selected ${row} for "${query}"`);
  await browser.keys("Enter");
  await gone("palette");
}

/** The preferences the app saved: `prefs.json` wraps them as `{ version, data }`. */
function savedPrefs(): Record<string, unknown> {
  const file = path.join(process.env.SKOPOS_CONFIG_DIR ?? "", "config", "prefs.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).data ?? {};
}

describe("in-app updates", () => {
  it("Check for Updates shows the release, which this copy cannot install itself", async () => {
    await shown("status-version");
    await runFromPalette("check for updates", "palette-command-check-updates");
    const dialog = await shown("update-dialog");
    await until(
      async () => (await dialog.getText()).includes("SkoposIDE 99.0.0 is available"),
      "the dialog never offered 99.0.0",
    );
    expect(await (await shown("update-notes")).getText()).toContain("Faster lists");
    expect(await (await shown("update-blocker")).getText()).toBe(
      "This copy can't update itself.",
    );
    expect(await dialogButton("Install and Restart").isExisting()).toBe(false);
    expect(await (await shown("status-update")).getText()).toBe("Update to 99.0.0");
  });

  it("Skip This Version closes the dialog and gives the status bar its version back", async () => {
    await (await dialogButton("Skip This Version")).click();
    await gone("update-dialog");
    await gone("status-update");
    await shown("status-version");
  });

  it("the Preferences switch turns automatic checks off, and the app saves it", async () => {
    await clickWhenShown("nav-preferences");
    const toggle = await shown("prefs-update-check");
    expect(await toggle.getAttribute("data-checked")).toBe("true");
    await toggle.click();
    await until(
      async () => savedPrefs().updateCheck === false,
      "prefs.json never saved updateCheck: false",
    );
    expect(await toggle.getAttribute("data-checked")).toBe("false");
  });
});
