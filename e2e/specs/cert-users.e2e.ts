import fs from "node:fs";
import path from "node:path";
import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId,
  clickNav,
  clickWhenShown,
  dialogButton,
  gone,
  openCluster,
  openResource,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-cert-users";
const USER = "e2e-cert-user";
const ROW = `ug-row-User:${USER}`;
const BINDING = `${USER}-view`;

/** The signing requests this spec's runs made: their names start with the user's slug. */
async function requests(): Promise<string[]> {
  const out = await kubectl([
    "get",
    "certificatesigningrequests",
    "-o",
    "jsonpath={.items[*].metadata.name}",
  ]);
  return out
    .split(/\s+/)
    .filter((name) => name.startsWith(`${USER}-`));
}

async function deleteRequests(): Promise<void> {
  const names = await requests();
  if (names.length > 0) {
    await kubectl(["delete", "certificatesigningrequests", "--ignore-not-found", ...names]);
  }
}

async function type(id: string, value: string): Promise<void> {
  const input = await shown(id);
  await input.setValue(value);
}

describe("users and groups from client certificates", () => {
  before(async function () {
    this.timeout(300000);
    await createTestNamespace(NS);
    await deleteRequests();
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
    await deleteRequests();
  });

  it("creates a user who may view one namespace and saves its kubeconfig", async () => {
    await clickNav("nav-users-groups");
    await shown("ug-title");
    await clickWhenShown("ug-create");
    await shown("cu-dialog");
    await type("cu-user", USER);
    await type("cu-groups", "e2e-team");
    await clickWhenShown("cu-grant");
    await clickWhenShown("cu-scope-namespace");
    await type("cu-namespace", NS);
    await type("cu-role", "view");
    expect(await byTestId("cu-binding-line").getText()).toBe(
      `Creates RoleBinding ${BINDING} in ${NS}.`,
    );
    await clickWhenShown("cu-submit");
    await gone("cu-dialog", 90000);

    const file = path.join(process.env.SKOPOS_E2E_SAVE_DIR ?? "", `${USER}.kubeconfig`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("client-certificate-data:");
    expect(text).toContain("client-key-data:");
    expect(text).toContain(`namespace: ${NS}`);

    const subjects = await kubectl([
      "get",
      "rolebinding",
      "-n",
      NS,
      BINDING,
      "-o",
      "jsonpath={.subjects[*].kind}/{.subjects[*].name}/{.roleRef.kind}/{.roleRef.name}",
    ]);
    expect(subjects).toBe(`User/${USER}/ClusterRole/view`);
    await shown(ROW, 30000);
  });

  it("lists the user's signing request as Issued", async () => {
    const [name] = await requests();
    expect(name).toBeDefined();
    await openResource(
      "nav-item-certificates.k8s.io-certificatesigningrequests",
      "CertificateSigningRequest",
    );
    const row = await shown(`resource-row-${name}`, 30000);
    await browser.waitUntil(async () => (await row.getText()).includes("Issued"), {
      timeout: 30000,
      timeoutMsg: `${name} never showed Issued`,
    });
  });

  it("removes the user from its bindings", async () => {
    await clickNav("nav-users-groups");
    await clickWhenShown(ROW);
    await shown("ug-drawer");
    await clickWhenShown("ug-drawer-remove");
    await shown("ug-remove");
    await (await dialogButton("Remove")).click();
    await gone(ROW, 30000);
    const left = await kubectl([
      "get",
      "rolebinding",
      "-n",
      NS,
      BINDING,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    expect(left.trim()).toBe("");
  });
});
