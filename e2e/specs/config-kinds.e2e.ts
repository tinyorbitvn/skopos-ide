import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, openCluster, openResource, rowId, searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-config";
const LAST_APPLIED = "{.metadata.annotations.kubectl\\.kubernetes\\.io/last-applied-configuration}";
const MANIFEST = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
  namespace: ${NS}
data:
  mode: fast
---
apiVersion: v1
kind: Secret
metadata:
  name: creds
  namespace: ${NS}
stringData:
  password: e2e-hidden-value
`;
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

/**
 * Reveals a Secret key with a click on its masked value, again if a late update
 * of the object masks it, until its field holds `value`.
 */
async function reveal(key: string, value: string) {
  await until(async () => {
    const masked = byTestId(`secret-value-${key}`);
    if (await masked.isExisting()) await masked.click();
    const input = byTestId(`secret-input-${key}`);
    return (await input.isExisting()) && (await input.getValue()) === value;
  }, `${key} never showed ${value}`);
}

async function openDrawer(nav: string, kind: string, name: string) {
  await openResource(nav, kind);
  await searchResources(name);
  await byTestId(rowId(NS, name)).click();
  await shown("detail-drawer");
}

describe("editing config in the drawer", () => {
  before(async () => {
    await deleteTestNamespace(NS);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("edits a ConfigMap in the drawer", async () => {
    await openDrawer("nav-item-core-configmaps", "ConfigMap", "settings");
    await (await shown("configmap-input-mode")).setValue("slow");
    await clickWhenShown("data-save");
    await until(
      async () => (await kubectl(["-n", NS, "get", "configmap", "settings", "-o", "jsonpath={.data.mode}"])) === "slow",
      "the ConfigMap never changed",
    );
    const applied = await kubectl(["-n", NS, "get", "configmap", "settings", "-o", `jsonpath=${LAST_APPLIED}`]);
    expect(applied).toContain("settings");
    await clickWhenShown("detail-close");
  });

  it("keeps a Secret value out of the page until it is revealed", async () => {
    await openDrawer("nav-item-core-secrets", "Secret", "creds");
    expect(await browser.getPageSource()).not.toContain("e2e-hidden-value");
    expect(await (await shown("secret-value-password")).getText()).toBe("••••••");
    await reveal("password", "e2e-hidden-value");
    await clickWhenShown("secret-reveal-password");
    await shown("secret-value-password");
    await until(async () => !(await browser.getPageSource()).includes("e2e-hidden-value"), "the value stayed after hiding");
    await clickWhenShown("detail-close");
  });

  it("edits a revealed Secret value in place", async () => {
    await openDrawer("nav-item-core-secrets", "Secret", "creds");
    expect(await byTestId("secret-edit-password").isExisting()).toBe(false);
    await reveal("password", "e2e-hidden-value");
    await (await shown("secret-input-password")).setValue("changed-value");
    await clickWhenShown("data-save");
    const expected = Buffer.from("changed-value").toString("base64");
    await until(
      async () => (await kubectl(["-n", NS, "get", "secret", "creds", "-o", "jsonpath={.data.password}"])) === expected,
      "the Secret never changed",
    );
    await clickWhenShown("detail-close");
  });

  it("saves a Secret value typed as base64, and reopens it as base64", async () => {
    await openDrawer("nav-item-core-secrets", "Secret", "creds");
    await reveal("password", "changed-value");
    const input = await shown("secret-input-password");
    await clickWhenShown("secret-form-password-base64");
    const encoded = Buffer.from("changed-value").toString("base64");
    await until(async () => (await input.getValue()) === encoded, "the value never turned to base64");
    // 0xff 0x00 0x01 is not UTF-8, so it can only be typed as base64.
    await input.setValue("/wAB");
    await clickWhenShown("data-save");
    await until(
      async () => (await kubectl(["-n", NS, "get", "secret", "creds", "-o", "jsonpath={.data.password}"])) === "/wAB",
      "the Secret never changed",
    );
    // The panel masks its values once the saved version arrives; until then the input
    // still holds the typed text, which reveal() would take for the saved value.
    await shown("secret-value-password");
    await reveal("password", "/wAB");
    // One query, read again on each try: a re-render may replace the switch's elements.
    await until(async () => {
      const raw = browser.$('[data-testid="secret-form-password-raw"] input');
      return (await raw.isExisting()) && !(await raw.isEnabled());
    }, "Raw was never offered as disabled for a binary value");
    await clickWhenShown("detail-close");
  });

  it("a stale save is refused and keeps the text", async () => {
    await openDrawer("nav-item-core-configmaps", "ConfigMap", "settings");
    const input = await shown("configmap-input-mode");
    await input.setValue("typed-text");
    await kubectl(["-n", NS, "patch", "configmap", "settings", "--type=merge", "-p", '{"data":{"mode":"server"}}']);
    await shown("data-changed-on-server");
    await clickWhenShown("data-save");
    await shown("data-conflict");
    expect(await (await shown("configmap-input-mode")).getValue()).toBe("typed-text");
    expect(await kubectl(["-n", NS, "get", "configmap", "settings", "-o", "jsonpath={.data.mode}"])).toBe("server");
  });
});
