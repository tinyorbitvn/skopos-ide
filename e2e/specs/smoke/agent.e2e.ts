import { permission, say, writeFakeAgentScript } from "../../helpers/fakeagent";
import {
  byTestId,
  catalogRow,
  clickWhenShown,
  expectConnected,
  shown,
} from "../../helpers/ui";

const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 250, timeoutMsg });

async function streamText(): Promise<string> {
  return browser.execute(
    () =>
      document.querySelector('[data-testid="agent-stream"]')?.textContent ?? "",
  );
}

// Runs without Docker: the only cluster is a fakekube context, the agent is the scripted one.
describe("agent smoke", () => {
  it("starts the fake agent, gets an answer and answers its permission request", async () => {
    writeFakeAgentScript([
      [say("Hello from the fake agent."), permission("Run echo", "echo hi"), say("Done.")],
    ]);
    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake", 30000);
    await (await catalogRow("fake")).$("a=fake").then((link) => link.click());
    await expectConnected();
    await clickWhenShown("agent-toggle");
    await shown("agent-new-chat-title", 60000);
    await (await byTestId("agent-message")).setValue("Hello");
    const sendButton = await byTestId("agent-send");
    await sendButton.waitForEnabled({ timeout: 15000 });
    await sendButton.click();
    await until(
      async () => (await streamText()).includes("Hello from the fake agent."),
      "no answer",
    );
    await clickWhenShown("agent-permission-allow_once");
    await until(
      async () => (await streamText()).includes("Done."),
      "the turn never finished",
    );
  });
});
