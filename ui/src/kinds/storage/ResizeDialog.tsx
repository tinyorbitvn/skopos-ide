import { useEffect, useState } from "react";
import { Button, Dialog, ErrorNotice, Input, toast } from "../../design";
import { parseQuantity } from "../../features/metrics/format";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { KubeObject } from "../objects";
import { STORAGE_CLASSES } from "../refs";
import styles from "./ResizeDialog.module.css";

/** What the claim's StorageClass says about expansion, once it is read. */
type ClassState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "read"; allows: boolean }
  | { status: "unknown"; message: string };

/**
 * Asks for a larger size on a PersistentVolumeClaim. Only a Bound claim whose StorageClass
 * allows volume expansion can grow; the dialog says why when it cannot, and leaves the
 * decision to the API server when the class cannot be read.
 */
export function ResizeDialog(props: {
  clusterId: string;
  object: KubeObject;
  close(): void;
}) {
  const { clusterId, object, close } = props;
  const { name, namespace = "" } = object.metadata;
  const requested: string | undefined =
    object.spec?.resources?.requests?.storage;
  const capacity: string | undefined = object.status?.capacity?.storage;
  const current = capacity ?? requested;
  const className: string | undefined =
    object.spec?.storageClassName || undefined;
  const phase: string | undefined = object.status?.phase;

  const [klass, setKlass] = useState<ClassState>(
    className ? { status: "loading" } : { status: "none" },
  );
  const [value, setValue] = useState(requested ?? current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!className) return;
    let live = true;
    api
      .resourceGet(clusterId, STORAGE_CLASSES, null, className)
      .then((sc) => {
        const allows =
          (sc as { allowVolumeExpansion?: unknown }).allowVolumeExpansion ===
          true;
        if (live) setKlass({ status: "read", allows });
      })
      .catch((e) => {
        if (live) setKlass({ status: "unknown", message: failureMessage(e) });
      });
    return () => {
      live = false;
    };
  }, [clusterId, className]);

  const blocked =
    phase !== "Bound"
      ? `This claim is ${phase ?? "not bound"}. Only a Bound claim can be resized.`
      : klass.status === "none"
        ? "This claim has no StorageClass, so it cannot be expanded."
        : klass.status === "read" && !klass.allows
          ? `StorageClass ${className} does not allow volume expansion.`
          : null;

  const size = parseQuantity(value);
  const floor = parseQuantity(current);
  const invalid =
    size === null || size <= 0
      ? "Enter a size such as 20Gi."
      : floor !== null && size <= floor
        ? `Enter a size larger than the current ${current}.`
        : null;
  const ready =
    blocked === null && klass.status !== "loading" && invalid === null;

  async function confirm() {
    if (!ready || busy) return;
    const storage = value.trim();
    setBusy(true);
    setError(null);
    try {
      await api.pvcResize(clusterId, namespace, name, storage);
      toast.success(`Requested ${storage} for ${name}`);
      close();
    } catch (e) {
      setError(failureMessage(e));
      setBusy(false);
    }
  }

  const classText =
    klass.status === "none"
      ? "None"
      : klass.status === "loading"
        ? `${className}, checking…`
        : klass.status === "read"
          ? `${className}, ${klass.allows ? "allows" : "does not allow"} expansion`
          : className;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Resize ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="resize-confirm"
            disabled={!ready || busy}
            onClick={confirm}
          >
            Resize
          </Button>
        </>
      }
    >
      <dl className={styles.facts} data-testid="resize-facts">
        <dt>Capacity</dt>
        <dd>{capacity ?? "Unknown"}</dd>
        <dt>Requested</dt>
        <dd>{requested ?? "None"}</dd>
        <dt>Storage class</dt>
        <dd>{classText}</dd>
      </dl>
      {blocked ? (
        <p className={styles.blocked} data-testid="resize-blocked">
          {blocked}
        </p>
      ) : null}
      {klass.status === "unknown" ? (
        <p className={styles.note} data-testid="resize-class-unknown">
          Could not read StorageClass {className}: {klass.message}. The API
          server refuses the resize if the class does not allow it.
        </p>
      ) : null}
      <Input
        label="New size"
        data-testid="resize-size"
        value={value}
        disabled={blocked !== null}
        onChange={(e) => setValue(e.target.value)}
        error={blocked === null ? (invalid ?? undefined) : undefined}
        help="A quantity, such as 20Gi. A volume can only grow."
        onKeyDown={(e) => {
          if (e.key === "Enter") void confirm();
        }}
      />
      {error ? <ErrorNotice title="Resize failed" message={error} /> : null}
    </Dialog>
  );
}
