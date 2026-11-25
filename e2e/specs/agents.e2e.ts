import { say, tool, writeFakeAgentScript } from "../helpers/fakeagent";
import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  editorContaining,
  hotbarItem,
  newInDock,
  openCluster,
  openResource,
  pointerClick,
  rowId,
  rowMenu,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-agents";
const DEPLOYMENTS = "nav-item-apps-deployments";

const WEB = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: ${NS}
spec:
  replicas: 1
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: main
          image: registry.k8s.io/pause:3.10
          env:
            - { name: MODE, value: slow }
`;

const PATCH = {
  kind: "Deployment",
  namespace: NS,
  name: "web",
  patch: {
    spec: {
      template: {
        spec: {
          containers: [
            { name: "main", env: [{ name: "MODE", value: "fast" }] },
          ],
        },
      },
    },
  },
  patch_type: "strategic",
  summary: "Set MODE=fast on main",
};

const until = (
  check: () => Promise<boolean>,
  timeoutMsg: string,
  timeout = 60000,
) => browser.waitUntil(check, { timeout, interval: 250, timeoutMsg });

/** The next chat lists the Deployments, asks to patch web, then finishes. */
function changeScript(): void {
  writeFakeAgentScript([
    [
      tool("list_objects", { kind: "Deployment", namespace: NS }),
      tool("patch_object", PATCH),
      say("Finished."),
    ],
  ]);
}

async function mode(): Promise<string> {
  const out = await kubectl([
    "-n",
    NS,
    "get",
    "deployment",
    "web",
    "-o",
    'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="MODE")].value}',
  ]);
  return out.trim();
}

async function resetMode(): Promise<void> {
  await kubectl(["-n", NS, "set", "env", "deployment/web", "MODE=slow"]);
  await kubectl([
    "-n",
    NS,
    "rollout",
    "status",
    "deployment/web",
    "--timeout=120s",
  ]);
}

/** A test id's text, read in the page (WebKitWebDriver's getText is unreliable in a row). */
async function text(id: string): Promise<string> {
  return browser.execute(
    (testId) =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "",
    id,
  );
}

/** The newest change card's state and text. */
async function lastCard(): Promise<{ state: string; text: string } | null> {
  return browser.execute(() => {
    const cards = document.querySelectorAll(
      '[data-testid="agent-change-card"]',
    );
    const card = cards[cards.length - 1];
    return card
      ? {
          state: card.getAttribute("data-state") ?? "",
          text: card.textContent ?? "",
        }
      : null;
  });
}

/** Clicks a button of the newest change card. */
async function clickInLastCard(testId: string): Promise<void> {
  const cards = await $$('[data-testid="agent-change-card"]');
  const card = cards[cards.length - 1];
  if (!card) throw new Error("no change card");
  await card.$(`[data-testid="${testId}"]`).click();
}

/** Waits for the chat to be ready, then sends `message`. */
async function send(message: string): Promise<void> {
  await shown("agent-new-chat-title", 60000);
  const box = await byTestId("agent-message");
  await box.setValue(message);
  const sendButton = await byTestId("agent-send");
  await sendButton.waitForEnabled({ timeout: 15000 });
  await sendButton.click();
}

/** A new chat in the open panel, after the script for it is written. */
async function newChat(): Promise<void> {
  await clickWhenShown("agent-new-chat");
}

async function runCommand(id: string): Promise<void> {
  await clickWhenShown("palette-open");
  await clickWhenShown(`palette-command-${id}`);
}

const PROPOSED = `apiVersion: v1
kind: ConfigMap
metadata:
  name: e2e-proposed
  namespace: ${NS}
data:
  source: agent
`;

describe("agents", () => {
  before(async () => {
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], WEB);
    await kubectl([
      "-n",
      NS,
      "rollout",
      "status",
      "deployment/web",
      "--timeout=120s",
    ]);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("asks about a Deployment from the drawer and applies an approved change", async () => {
    changeScript();
    await openCluster(KIND);
    await openResource(DEPLOYMENTS, "Deployment");
    await byTestId(rowId(NS, "web")).click();
    await shown("detail-drawer");
    await pointerClick(await byTestId("detail-more-actions"));
    await clickWhenShown("menu-item-agent-ask");
    await shown("agent-panel");
    await until(
      async () =>
        (await text("agent-object-chip")).startsWith(`Deployment ${NS}/web`),
      "the composer never showed the Deployment",
    );
    await send("Make web fast");
    await until(
      async () => (await lastCard())?.state === "waiting",
      "no change card waited for an answer",
    );
    expect((await lastCard())?.text).toContain(`Change Deployment ${NS}/web`);
    await clickInLastCard("agent-approve");
    await until(
      async () =>
        (await lastCard())?.text.includes("Approved. Applied at") ?? false,
      "the card never said Approved",
    );
    await until(
      async () => (await mode()) === "fast",
      "MODE never became fast",
    );
    await until(
      async () => (await text("agent-rollout")) === "Rolled out 1 of 1 Pods",
      "the rollout line never said Rolled out 1 of 1 Pods",
      180000,
    );
  });

  it("leaves the cluster as it was after Deny", async () => {
    await resetMode();
    changeScript();
    await newChat();
    await send("Make web fast");
    await until(
      async () => (await lastCard())?.state === "waiting",
      "no change card waited",
    );
    await clickInLastCard("agent-deny");
    await until(
      async () =>
        (await lastCard())?.text.includes("Denied. The agent was told no.") ??
        false,
      "the card never said Denied",
    );
    expect(await mode()).toBe("slow");
  });

  it("refuses the agent's change under Read only", async () => {
    await runCommand("preferences");
    const option = await $(
      '[data-testid^="pref-changes-"][data-testid$="-mode-readOnly"]',
    );
    await option.waitForExist({ timeout: 15000 });
    await option.click();
    await openCluster(KIND);
    changeScript();
    await shown("agent-panel");
    await newChat();
    await shown("agent-read-only");
    await send("Make web fast");
    await until(
      async () =>
        (await text("agent-stream")).includes(
          `tool:patch_object:error: Changes to ${KIND} are read only for agents.`,
        ),
      "the agent was not told the cluster is read only",
    );
    expect(await lastCard()).toBeNull();
    expect(await mode()).toBe("slow");
  });

  it("opens the Agent card from the hotbar and applies without asking under Don't ask", async () => {
    await runCommand("catalog");
    await rowMenu(KIND, "pin");
    const tile = await hotbarItem(KIND);
    await browser.execute((el) => {
      const target = el as unknown as HTMLElement;
      const { x, y } = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: x + 4,
          clientY: y + 4,
        }),
      );
    }, tile);
    await clickWhenShown("menu-item-agent-settings");
    await shown("settings-agent-card");
    await until(
      async () =>
        browser.execute(() => document.activeElement?.id === "settings-agent"),
      "the Agent card did not get focus",
    );
    await clickWhenShown("settings-agent-changes-dontAsk");
    await clickWhenShown("settings-save");
    await until(
      async () => (await byTestId("settings-save").isEnabled()) === false,
      "the settings were not saved",
    );
    await openCluster(KIND);
    changeScript();
    await shown("agent-panel");
    await newChat();
    await send("Make web fast");
    await until(
      async () => (await lastCard())?.state === "appliedWithoutAsking",
      "the change did not run without asking",
    );
    expect((await lastCard())?.text).toContain(
      `Applied without asking. Your setting for ${KIND} allows it.`,
    );
    await until(
      async () => (await mode()) === "fast",
      "MODE never became fast",
    );
  });

  it("puts the agent's proposal into a create tab, which applies it", async () => {
    writeFakeAgentScript([[tool("propose_yaml", { yaml: PROPOSED, summary: "Add the e2e ConfigMap" }), say("Proposed.")]]);
    await openCluster(KIND);
    // The agent reads its script when it starts: a new chat on this cluster plays this one.
    await shown("agent-panel");
    await newChat();
    await shown("agent-new-chat-title", 60000);
    await newInDock("create-resource");
    await clickWhenShown("yaml-ai");
    await (await shown("yaml-ai-input")).setValue("Create a ConfigMap");
    await clickWhenShown("yaml-ai-send");
    await shown("yaml-proposal-bar", 60000);
    expect(await text("yaml-proposal-bar")).toContain("Add the e2e ConfigMap");
    await clickWhenShown("yaml-proposal-accept");
    await editorContaining("name: e2e-proposed");
    await clickWhenShown("create-apply");
    await until(
      async () => (await (await byTestId("apply-result-0")).getAttribute("data-ok")) === "true",
      "the proposal was never applied",
    );
    expect(await kubectl(["-n", NS, "get", "configmap", "e2e-proposed", "-o", "jsonpath={.data.source}"])).toBe("agent");
  });
});
