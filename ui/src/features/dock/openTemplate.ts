import { newCreateTab, useDock, writeDraft } from "../../stores/dock";
import type { CreateDraft } from "../editor/CreateResourceTab";
import type { Template } from "../editor/templates/catalog";

/** A create tab holding `template` as its text and baseline, so it is not dirty (spec D3). */
export function openTemplate(clusterId: string, template: Template): void {
  const tab = newCreateTab(clusterId, `New ${template.label}`);
  useDock.getState().open(tab);
  writeDraft(tab.id, {
    text: template.yaml,
    baseline: template.yaml,
    results: [],
  } satisfies CreateDraft);
}

/** A blank create tab with its AI bar open (spec D2's Draft with AI). */
export function openAiDraft(clusterId: string): void {
  const tab = newCreateTab(clusterId);
  useDock.getState().open(tab);
  writeDraft(tab.id, {
    text: "",
    baseline: "",
    results: [],
    ai: true,
  } satisfies CreateDraft);
}
