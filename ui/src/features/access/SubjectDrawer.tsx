import { useEffect, useRef } from "react";
import { IconButton, Tabs, Tooltip } from "../../design";
import { UserX } from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { ObjectLink, Part, SimpleTable } from "../../kinds/detail/parts";
import styles from "../details/DetailDrawer.module.css";
import { DrawerShell } from "../details/DrawerShell";
import bar from "../resources/ObjectActionBar.module.css";
import { isSystemName, type SubjectEntry } from "./subjects";

const TABS = [{ value: "overview", label: "Overview" }];
const RBAC_API_VERSION = "rbac.authorization.k8s.io/v1";
const SYSTEM = "Kubernetes manages system users and groups";

/** A User or Group: the bindings that name it (spec 2026-11-22 §5.3). */
export function SubjectDrawer(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  subject: SubjectEntry;
  onRemove(): void;
  onClose(): void;
}) {
  const { clusterId, resources, subject, onRemove, onClose } = props;
  const drawerRef = useRef<HTMLElement>(null);

  // As in the object drawer: focus comes in on open and goes back where it was.
  useEffect(() => {
    const before = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const system = isSystemName(subject.name);
  const remove = (
    <IconButton
      label="Remove from bindings"
      icon={<UserX size={16} aria-hidden="true" />}
      disabled={system}
      // A disabled button gets no hover or focus, so its wrapper carries the reason.
      tooltip={!system}
      onClick={onRemove}
      data-testid="ug-drawer-remove"
    />
  );

  return (
    <DrawerShell
      ref={drawerRef}
      label={`${subject.kind} details`}
      testId="ug-drawer"
      kind={subject.kind}
      kindTestId="ug-drawer-kind"
      title={subject.name}
      titleTestId="ug-drawer-title"
      closeTestId="ug-drawer-close"
      onClose={onClose}
      closeOnEscape
      actions={
        // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a header toolbar does not want.
        <div role="group" aria-label="Actions" className={bar.bar}>
          {system ? (
            <Tooltip content={SYSTEM}>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the reason a disabled button is disabled must be reachable by keyboard. */}
              <span tabIndex={0} data-testid="ug-drawer-remove-why">
                {remove}
              </span>
            </Tooltip>
          ) : (
            remove
          )}
        </div>
      }
    >
      <Tabs value="overview" onChange={() => {}} tabs={TABS} />
      <div className={styles.content}>
        <Part title="Bindings" count={subject.bindings.length}>
          <SimpleTable
            testId="ug-drawer-bindings"
            headers={["Binding", "Role", "Namespace"]}
            rows={subject.bindings.map((b) => [
              <ObjectLink
                key="binding"
                clusterId={clusterId}
                resources={resources}
                kind={b.kind}
                name={b.name}
                namespace={b.namespace ?? undefined}
                apiVersion={RBAC_API_VERSION}
              />,
              <ObjectLink
                key="role"
                clusterId={clusterId}
                resources={resources}
                kind={b.roleKind}
                name={b.roleName}
                // A ClusterRole has no namespace, whatever binds it.
                namespace={
                  b.roleKind === "Role" ? (b.namespace ?? undefined) : undefined
                }
                apiVersion={RBAC_API_VERSION}
              />,
              b.namespace ?? "Cluster",
            ])}
            empty="No bindings."
          />
        </Part>
      </div>
    </DrawerShell>
  );
}
