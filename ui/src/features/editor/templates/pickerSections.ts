import type { PickerSection } from "../../../design/PickerMenu";
import { isServed, type ServedKind } from "../servedKinds";
import { TEMPLATE_GROUPS, TEMPLATES, type Template } from "./catalog";

export const NOT_SERVED = "Not served by this cluster";

/** The templates as picker sections, one per group (spec T2, T4, D2). */
export function templateSections(
  served: ServedKind[],
  onPick: (template: Template) => void,
): PickerSection[] {
  return TEMPLATE_GROUPS.map((group) => ({
    id: group.id,
    title: group.label,
    items: TEMPLATES.filter((t) => t.group === group.id).map((template) => ({
      id: template.id,
      label: template.label,
      keywords: [template.kind, group.label],
      disabled: !isServed(served, template.apiVersion, template.kind),
      disabledHint: NOT_SERVED,
      testId: `menu-item-${template.id}`,
      onSelect: () => onPick(template),
    })),
  }));
}
