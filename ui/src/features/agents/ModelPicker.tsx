import { PickerMenu, type PickerSection, Tooltip } from "../../design";
import { ChevronDown } from "../../design/icons";
import type { ModelChoice } from "../../ipc/generated/ModelChoice";
import { useAgentChat } from "../../stores/agentChat";
import styles from "./AgentPanel.module.css";

const WAIT = "Wait for the answer to change the model";

/** The agent's groups as titled sections in its order; ungrouped models in one section. */
export function modelSections(
  model: ModelChoice,
  pick: (id: string) => void,
): PickerSection[] {
  const sections: PickerSection[] = [];
  for (const choice of model.choices) {
    const title = choice.group ?? undefined;
    let section = sections[sections.length - 1];
    if (!section || section.title !== title) {
      section = {
        id: `group-${sections.length}`,
        ...(title ? { title } : {}),
        items: [],
      };
      sections.push(section);
    }
    section.items.push({
      id: choice.id,
      label: choice.name,
      ...(choice.description ? { description: choice.description } : {}),
      keywords: [choice.id, choice.description, choice.group].filter(
        (word): word is string => !!word,
      ),
      checked: choice.id === model.current,
      testId: `agent-model-${choice.id}`,
      onSelect: () => pick(choice.id),
    });
  }
  return sections;
}

/** The chat's model picker (native agents spec §6.1); nothing when the agent offers none. */
export function ModelPicker() {
  const model = useAgentChat((s) => s.model);
  const busy = useAgentChat((s) => s.busy);
  const changing = useAgentChat((s) => s.modelChanging);
  if (!model) return null;
  const blocked = busy || changing;
  const name =
    model.choices.find((choice) => choice.id === model.current)?.name ??
    model.current;
  return (
    <PickerMenu
      label="Model"
      searchLabel="Search models"
      testId="agent-model-menu"
      width={300}
      sections={modelSections(
        model,
        (id) => void useAgentChat.getState().setModel(id),
      )}
      empty={(query) => `No model matches "${query}".`}
      trigger={({ open, toggle }) => (
        <Tooltip content={busy ? WAIT : name}>
          <button
            type="button"
            className={styles.modelButton}
            aria-label={`Model: ${name}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (!blocked) toggle();
            }}
            data-testid="agent-model"
          >
            <span className={styles.ellipsis}>{name}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    />
  );
}
