import { SSHD_PASSWORD_VAR, SSHD_PORT_VAR } from "../helpers/fakesshd";
import { pickOption, replaceText } from "../helpers/helm";
import {
  byTestId, catalogRow, clickWhenShown, closeDockTabs, dialogButton, expectConnected,
  expectTerminalLine, expectTerminalStatus, gone, newInDock, rowMenu, shown, typeInTerminal,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const TUNNEL = "bastion";
const SAVED = "Saved. Changes apply at once; the tunnel applies on the next connect.";
/** The tunnels fixture's skopos-fakesshd, the only one that resolves the kind API server. */
const port = process.env[SSHD_PORT_VAR] ?? "";
const password = process.env[SSHD_PASSWORD_VAR] ?? "";

const until = (check: () => Promise<boolean>, timeoutMsg: string, timeout = 60000) =>
  browser.waitUntil(check, { timeout, interval: 500, timeoutMsg });

async function text(id: string): Promise<string> {
  const element = byTestId(id);
  if (!(await element.isExisting())) return "";
  return (await element.getText()).trim();
}

// Tunnels spec §6.6: add an SSH tunnel, pick it in the cluster's settings, connect, and run
// kubectl in the cluster's terminal. Only the tunnel reaches the kind API server's name.
describe("SSH tunnels", () => {
  before(() => {
    if (port === "" || password === "") {
      throw new Error("the tunnels fixture did not start skopos-fakesshd");
    }
  });

  after(async () => {
    await closeDockTabs();
  });

  it("adds an SSH tunnel in Preferences", async () => {
    await clickWhenShown("nav-preferences");
    await shown("prefs-tunnels");
    await clickWhenShown("prefs-tunnels-add");
    await shown("tunnel-dialog");
    await clickWhenShown("tunnel-kind-ssh");
    await replaceText("tunnel-name", TUNNEL);
    await replaceText("tunnel-host", "127.0.0.1");
    await replaceText("tunnel-user", "me");
    await replaceText("tunnel-port", port);
    await clickWhenShown("tunnel-save");
    await gone("tunnel-dialog");
    await until(
      async () => (await text("prefs-tunnels")).includes(`SSH · me@127.0.0.1:${port}`),
      "the tunnel's row never showed",
    );
  });

  it("picks the tunnel in the cluster's settings", async () => {
    await clickWhenShown("nav-catalog");
    await shown(`catalog-row-${KIND}`, 30000);
    await rowMenu(KIND, "settings");
    await shown("cluster-settings", 30_000);
    await pickOption("settings-tunnel", TUNNEL);
    const save = byTestId("settings-save");
    await save.waitForEnabled({ timeout: 15_000 });
    await save.click();
    await until(async () => (await text("settings-status")) === SAVED, "the settings were never saved");
  });

  it("connects after the person trusts the host key and gives the password", async () => {
    await clickWhenShown("nav-catalog");
    await (await catalogRow(KIND)).$(`a=${KIND}`).then((link) => link.click());
    // The connect is the person's action, so ssh's prompts open at once.
    const dialog = await shown("tunnel-prompt", 60_000);
    expect(await dialog.getText()).toContain(`SSH for "${TUNNEL}"`);
    expect(await text("tunnel-prompt-text")).toContain("SHA256:");
    expect(await text("tunnel-prompt-continue")).toBe("Trust and connect");
    expect(await byTestId("tunnel-prompt-answer").isExisting()).toBe(false);
    await clickWhenShown("tunnel-prompt-continue");

    const field = await shown("tunnel-prompt-answer", 60_000);
    expect(await text("tunnel-prompt-text")).toContain("password");
    await field.setValue(password);
    await clickWhenShown("tunnel-prompt-continue");
    await gone("tunnel-prompt");
    await expectConnected(90_000);
    await shown("cluster-sidebar");
  });

  it("runs kubectl get ns in the cluster's terminal through the tunnel", async () => {
    await newInDock("dock-terminal");
    await expectTerminalStatus("Local shell");
    await typeInTerminal("kubectl get ns kube-system -o name");
    await expectTerminalLine("namespace/kube-system");
  });

  it("Stop names the cluster, disconnects it and stops ssh", async () => {
    await closeDockTabs();
    await clickWhenShown("nav-preferences");
    await shown("prefs-tunnels");
    const stop = browser.$('[data-testid^="prefs-tunnel-stop-"]');
    await stop.waitForDisplayed({ timeout: 15_000 });
    await stop.click();
    const confirm = await shown("tunnel-stop-dialog");
    expect(await confirm.getText()).toContain(`${KIND} disconnects.`);
    await dialogButton("Stop").click();
    await gone("tunnel-stop-dialog");
    await until(async () => (await text("prefs-tunnels")).includes("Idle"), "the tunnel never stopped");
  });
});
