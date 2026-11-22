import fs from "node:fs";
import { EXEC_CONSENT_MARKER } from "../helpers/fixtures";
import {
  byTestId,
  catalogRow,
  clickWhenShown,
  dialogButton,
  expectConnected,
  gone,
  shown,
} from "../helpers/ui";

const CONTEXT = "exec-plugin";

/** Opens the cluster from the catalog by its name link, which starts a connect. */
async function openFromCatalog(): Promise<void> {
  await clickWhenShown("nav-catalog");
  await shown(`catalog-row-${CONTEXT}`, 30000);
  await (await catalogRow(CONTEXT))
    .$(`a=${CONTEXT}`)
    .then((link) => link.click());
}

describe("exec plugin consent", () => {
  it("asks before the kubeconfig's program runs, and Cancel runs nothing", async () => {
    await openFromCatalog();

    await shown("exec-consent-dialog");
    expect(await byTestId("exec-consent-program").getText()).toBe("/bin/sh");
    expect(await byTestId("exec-consent-args").getText()).toContain(
      "2 arguments",
    );
    expect(fs.existsSync(EXEC_CONSENT_MARKER)).toBe(false);

    await dialogButton("Cancel").click();
    await gone("exec-consent-dialog");
    expect(await (await shown("connection-status")).getText()).toBe(
      "Needs permission",
    );
    expect(fs.existsSync(EXEC_CONSENT_MARKER)).toBe(false);
  });

  it("shows the arguments on request, and connects once allowed", async () => {
    await clickWhenShown("cluster-review-exec");
    await shown("exec-consent-dialog");

    await clickWhenShown("exec-consent-show");
    await browser.waitUntil(
      async () =>
        (await byTestId("exec-consent-args").getText()).includes("touch"),
      { timeoutMsg: "the arguments never showed" },
    );

    await dialogButton("Allow and connect").click();
    await expectConnected();
    expect(fs.existsSync(EXEC_CONSENT_MARKER)).toBe(true);
  });
});
