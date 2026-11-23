import { afterEach, expect, test } from "vitest";
import { keepDraft, resetDraftsForTest, restoredDraft } from "./drafts";
import { emptyDraft } from "./settingsForm";

afterEach(() => resetDraftsForTest());

test("agent fields the person did not edit take the freshly loaded value", () => {
  const base = { ...emptyDraft(), agentChanges: "dontAsk" as const };
  keepDraft("c", { ...base, agentNotes: "edited" }, base);
  const fresh = { ...base, agentChanges: "readOnly" as const };
  const restored = restoredDraft("c", fresh);
  expect(restored?.agentChanges).toBe("readOnly");
  expect(restored?.agentNotes).toBe("edited");
});

test("an agent field the person edited stays", () => {
  const base = emptyDraft();
  keepDraft("c", { ...base, agentChanges: "dontAsk" }, base);
  const restored = restoredDraft("c", { ...base, agentChanges: "readOnly" });
  expect(restored?.agentChanges).toBe("dontAsk");
});
