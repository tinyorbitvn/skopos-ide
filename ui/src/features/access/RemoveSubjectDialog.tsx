import { useState } from "react";
import { Button, ConfirmDialog, Dialog, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { SubjectRemoval } from "../../ipc/generated/SubjectRemoval";
import own from "./access.module.css";
import {
  bindingsText,
  bindingText,
  removalLine,
  type SubjectEntry,
  toBindingRef,
} from "./subjects";

/** Why a binding was left as it was; `null` when the subject is gone from it. */
function reason(removal: SubjectRemoval): string | null {
  switch (removal.outcome.type) {
    case "updated":
    case "deleted":
      return null;
    case "conflict":
      return "Changed since you opened it. Try again.";
    case "failed":
      return removal.outcome.error.message;
  }
}

function note(subject: SubjectEntry): string {
  return subject.kind === "User"
    ? "Access through groups, such as system:authenticated, stays. The user's certificates stay valid until they expire, without this access."
    : `Every member of ${subject.name} loses the access these bindings give.`;
}

/**
 * Remove from bindings (spec 2026-11-22 §5.3): the confirm, then a toast, or a dialog
 * listing the bindings left as they were. Open while mounted.
 */
export function RemoveSubjectDialog(props: {
  clusterId: string;
  subject: SubjectEntry;
  onClose(): void;
}) {
  const { clusterId, subject, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<SubjectRemoval[] | null>(null);
  const total = subject.bindings.length;

  async function remove() {
    setBusy(true);
    try {
      const results = await api.accessSubjectRemove(
        clusterId,
        { kind: subject.kind, name: subject.name },
        subject.bindings.map(toBindingRef),
      );
      const kept = results.filter((r) => reason(r) !== null);
      if (kept.length === 0) {
        toast.success(`Removed ${subject.name} from ${bindingsText(total)}`);
        onClose();
      } else {
        setLeft(kept);
      }
    } catch (error) {
      toast.error(
        `Could not remove ${subject.name} from its bindings`,
        failureMessage(error),
      );
      onClose();
    }
  }

  if (left !== null) {
    return (
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title={`Removed ${subject.name} from ${total - left.length} of ${bindingsText(total)}`}
        testId="ug-result"
        footer={
          <Button onClick={onClose} data-testid="ug-result-close">
            Close
          </Button>
        }
      >
        <ul className={own.rows}>
          {left.map((r) => (
            <li key={bindingText(r.binding)}>
              <span className={own.mono}>{bindingText(r.binding)}</span> ·{" "}
              {reason(r)}
            </li>
          ))}
        </ul>
      </Dialog>
    );
  }

  return (
    <ConfirmDialog
      open
      danger
      testId="ug-remove"
      title={`Remove ${subject.kind} ${subject.name} from ${bindingsText(total)}?`}
      confirmLabel="Remove"
      confirmDisabled={busy}
      onConfirm={() => {
        void remove();
      }}
      onCancel={() => {
        // The call goes on in the core either way; its answer needs a place to land.
        if (!busy) onClose();
      }}
      body={
        <>
          <ul className={own.rows}>
            {subject.bindings.map((b) => (
              <li key={bindingText(b)}>
                <span className={own.mono}>{bindingText(b)}</span> ·{" "}
                {removalLine(b)}
              </li>
            ))}
          </ul>
          <p className={own.help}>{note(subject)}</p>
        </>
      }
    />
  );
}
