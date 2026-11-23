import { useState } from "react";
import { Button, Dialog, Input } from "../../design";
import { failureMessage } from "../../ipc/client";
import { useAgents } from "../../stores/agents";
import styles from "./PreferencesScreen.module.css";

/** `Add an agent`: a name and an ACP command (spec §3.5). */
export function AddAgentDialog(props: { onClose(): void }) {
  const add = useAgents((s) => s.add);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function submit(): Promise<void> {
    if (name.trim() === "" || command.trim() === "") {
      setProblem("Enter a name and a command.");
      return;
    }
    setAdding(true);
    try {
      await add(name.trim(), command.trim());
      props.onClose();
    } catch (error) {
      setProblem(failureMessage(error));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="Add an agent"
      testId="agent-add-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={adding}
            onClick={() => void submit()}
            data-testid="agent-add-submit"
          >
            Add
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <Input
          label="Name"
          placeholder="My agent"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setProblem(null);
          }}
          data-testid="agent-add-name"
        />
        <Input
          label="Command"
          placeholder="my-agent --acp"
          help="The command must speak the Agent Client Protocol on standard input and output."
          className={styles.monoInput}
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            setProblem(null);
          }}
          data-testid="agent-add-command"
        />
        {problem ? (
          <p className={styles.formError} role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
