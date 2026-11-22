import { type ReactNode, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Badge,
  EmptyState,
  ErrorNotice,
  Input,
  Segmented,
  Spinner,
  Switch,
  type TableColumn,
  VirtualTable,
} from "../../design";
import { CLUSTER_ROLE_BINDINGS, ROLE_BINDINGS } from "../../kinds/refs";
import {
  type ResourceListState,
  useResourceList,
} from "../../stores/resources";
import { useUiState } from "../../stores/uiState";
import { useClusterContext } from "../cluster/ClusterLayout";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import styles from "../resources/ResourceScreen.module.css";
import own from "./access.module.css";
import {
  collectSubjects,
  filterSubjects,
  type KindFilter,
  type SubjectEntry,
} from "./subjects";

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "users", label: "Users" },
  { value: "groups", label: "Groups" },
];

const LEAD =
  "Kubernetes has no User or Group objects. This list comes from the subjects of RoleBindings and ClusterRoleBindings.";

const COLUMNS: TableColumn<SubjectEntry>[] = [
  {
    id: "name",
    header: "Name",
    width: "minmax(180px, 2fr)",
    sortValue: (s) => s.name,
    render: (s) => s.name,
  },
  {
    id: "kind",
    header: "Kind",
    width: 96,
    sortValue: (s) => s.kind,
    render: (s) => <Badge tone="neutral">{s.kind}</Badge>,
  },
  {
    id: "bindings",
    header: "Bindings",
    width: 96,
    sortValue: (s) => s.bindings.length,
    render: (s) => String(s.bindings.length),
  },
  {
    id: "roles",
    header: "Roles",
    width: "minmax(200px, 3fr)",
    render: (s) => s.roles.join(", "),
  },
  {
    id: "scope",
    header: "Scope",
    width: "minmax(140px, 2fr)",
    render: (s) => s.scope.join(", "),
  },
];

/**
 * A list the backend refused for good. A snapshot leaves the status at `syncing` until
 * a `live` status arrives, so `loading` is what says the first snapshot came.
 */
function refused(list: ResourceListState): boolean {
  return list.status === "forbidden" || list.status === "notServed";
}

function partialNote(
  clusterBindings: ResourceListState,
  roleBindings: ResourceListState,
): string | null {
  if (!refused(clusterBindings) && roleBindings.status === "forbidden") {
    return "You may not list RoleBindings. The list shows users and groups from ClusterRoleBindings only.";
  }
  if (!refused(roleBindings) && clusterBindings.status === "forbidden") {
    return "You may not list ClusterRoleBindings. The list shows users and groups from RoleBindings only.";
  }
  return null;
}

/** The Users and Groups that bindings name (spec 2026-11-22 §5.3). */
export function UsersGroupsScreen({ clusterId }: { clusterId: string }) {
  const [namespaces] = useUiState<string[]>(namespaceFilterKey(clusterId), []);
  const clusterBindings = useResourceList(clusterId, CLUSTER_ROLE_BINDINGS);
  const roleBindings = useResourceList(clusterId, ROLE_BINDINGS, namespaces);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [showSystem, setShowSystem] = useState(false);
  const [params, setParams] = useSearchParams();
  const all = useMemo(
    () => collectSubjects(clusterBindings.items, roleBindings.items),
    [clusterBindings.items, roleBindings.items],
  );
  const rows = useMemo(
    () => filterSubjects(all, { query, kind, showSystem }),
    [all, query, kind, showSystem],
  );
  const openKey = params.get("subject");
  // From the live lists, so the drawer closes when its subject leaves every binding.
  const opened =
    openKey === null ? undefined : all.find((s) => s.key === openKey);

  function open(key: string | null) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (key === null) next.delete("subject");
        else next.set("subject", key);
        return next;
      },
      { replace: true },
    );
  }

  const settled = !clusterBindings.loading && !roleBindings.loading;
  const anyReadable = !refused(clusterBindings) || !refused(roleBindings);
  const partial = settled ? partialNote(clusterBindings, roleBindings) : null;

  let body: ReactNode;
  if (settled && !anyReadable) {
    body = (
      <div data-testid="ug-error">
        <ErrorNotice
          title="Could not load bindings"
          message={clusterBindings.message ?? roleBindings.message ?? ""}
        />
      </div>
    );
  } else if (!settled) {
    body = <Spinner label="Loading bindings" />;
  } else if (all.length === 0) {
    body = (
      <div data-testid="ug-empty">
        <EmptyState
          title="No bindings name a user or group"
          body="Create a user with a client certificate, or bind a role to a user or group."
        />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div data-testid="ug-no-match">
        <EmptyState title="No users or groups match the filters." />
      </div>
    );
  } else {
    body = (
      <VirtualTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(s) => s.key}
        rowTestId={(s) => `ug-row-${s.key}`}
        rowLabel={(s) => `${s.kind} ${s.name}`}
        onRowClick={(s) => open(s.key)}
        activeKey={opened?.key}
        testId="ug-table"
      />
    );
  }

  return (
    <div className={styles.screen} data-testid="users-groups-screen">
      <div className={styles.toolbar} data-keeps-drawer="">
        <h2 className={styles.title} data-testid="ug-title">
          Users & Groups
        </h2>
        {settled && anyReadable ? (
          <span data-testid="ug-count">
            <Badge tone="neutral">{rows.length}</Badge>
          </span>
        ) : null}
        <Input
          aria-label="Search users and groups"
          placeholder="Search users and groups"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="ug-search"
        />
        <Segmented<KindFilter>
          label="Kind"
          size="sm"
          value={kind}
          options={KIND_OPTIONS}
          onChange={setKind}
          testId="ug-kind"
        />
        <Switch
          label="Show system"
          size="sm"
          checked={showSystem}
          onChange={setShowSystem}
          testId="ug-system"
        />
        <div className={styles.grow} />
      </div>
      <p className={own.lead} data-testid="ug-lead">
        {LEAD}
      </p>
      {partial ? (
        <div className={own.notice} role="status" data-testid="ug-partial">
          <strong>Some bindings can't be read</strong>
          <p>{partial}</p>
        </div>
      ) : null}
      <div className={styles.body}>
        <div className={styles.main}>{body}</div>
      </div>
    </div>
  );
}

/** The route inside a connected cluster's layout. */
export function UsersGroupsRoute() {
  const { clusterId } = useClusterContext();
  return <UsersGroupsScreen key={clusterId} clusterId={clusterId} />;
}
