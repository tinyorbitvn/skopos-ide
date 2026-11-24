import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import {
  Button,
  EmptyState,
  Input,
  Select,
  Spinner,
  Tooltip,
} from "../../design";
import { TriangleAlert } from "../../design/icons";
import type { PolicyRef } from "../../ipc/generated/PolicyRef";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { useClusterNamespaces } from "../../stores/clusters";
import { retryReachability, useReachability } from "../../stores/reachability";
import { findResource } from "../../stores/resources";
import { useUiState } from "../../stores/uiState";
import { useClusterContext } from "../cluster/ClusterLayout";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import { useOverviewDrawer } from "../sections/useOverviewDrawer";
import styles from "./ReachabilityScreen.module.css";
import { ReachMatrix } from "./ReachMatrix";
import { type PolicyOpener, ReachPanel } from "./ReachPanel";
import {
  capText,
  countChips,
  matrixColumns,
  matrixRows,
  missingLine,
  notEvaluatedChip,
  panelOf,
  policyTarget,
  startNamespace,
} from "./reachModel";

/** The kinds a policy chip opens in the drawer (spec §7.5). */
const POLICY_KINDS = [
  ["networking.k8s.io", "networkpolicies"],
  ["cilium.io", "ciliumnetworkpolicies"],
  ["cilium.io", "ciliumclusterwidenetworkpolicies"],
] as const;

const NO_NAMESPACES: string[] = [];

/** The last namespace picked on a cluster (R8). Storage may be unavailable: then none. */
function storedNamespace(clusterId: string): string | null {
  try {
    return localStorage.getItem(`reachability.namespace.${clusterId}`);
  } catch {
    return null;
  }
}

function storeNamespace(clusterId: string, namespace: string): void {
  try {
    localStorage.setItem(`reachability.namespace.${clusterId}`, namespace);
  } catch {
    // Nothing to remember it in; the URL still holds it.
  }
}

const CAPTION =
  "From the NetworkPolicies and Cilium policies that select Pods in this namespace. What the network plugin enforces may differ.";

function Loading() {
  return (
    <div className={styles.state} data-testid="reach-loading">
      <Spinner label="Loading reachability…" />
    </div>
  );
}

/** The bar, the states, and the matrix with its panel, for one namespace. */
function ReachView(props: {
  clusterId: string;
  namespace: string;
  namespaces: string[];
  onPick(namespace: string): void;
  opener: PolicyOpener;
}) {
  const { clusterId, namespace } = props;
  const { snapshot, error, loading } = useReachability(clusterId, namespace);
  // The filter typed in a namespace; another namespace starts unfiltered.
  const [filter, setFilter] = useState({ namespace, text: "" });
  const query = filter.namespace === namespace ? filter.text : "";
  // The workload picked in a namespace; another namespace starts with none.
  const [picked, setPicked] = useState<{
    namespace: string;
    id: string;
  } | null>(null);
  const rows = useMemo(
    () => (snapshot === null ? [] : matrixRows(snapshot, query)),
    [snapshot, query],
  );
  const columns = useMemo(
    () => (snapshot === null ? [] : matrixColumns(snapshot, query)),
    [snapshot, query],
  );
  const selected =
    picked !== null &&
    picked.namespace === namespace &&
    snapshot?.groups.some((g) => g.id === picked.id)
      ? picked.id
      : null;
  const onSelect = useCallback(
    (id: string) =>
      setPicked((p) =>
        p?.namespace === namespace && p.id === id ? null : { namespace, id },
      ),
    [namespace],
  );
  const options = useMemo(
    () =>
      [...new Set([...props.namespaces, namespace])]
        .sort()
        .map((n) => ({ value: n, label: n })),
    [props.namespaces, namespace],
  );
  const notEvaluated = snapshot === null ? null : notEvaluatedChip(snapshot);
  const cap = snapshot === null ? null : capText(snapshot, query);

  let body: ReactNode = null;
  if (snapshot === null) {
    if (loading) body = <Loading />;
  } else if (snapshot.groups.length === 0) {
    body = (
      <div className={styles.state} data-testid="reach-empty">
        <EmptyState title={`No Pods in ${namespace}`} />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className={styles.state} data-testid="reach-no-match">
        <EmptyState title={`No workloads match "${query}"`} />
      </div>
    );
  } else {
    const first = snapshot.groups[0]?.id ?? "";
    body = (
      <div className={styles.split}>
        <div className={styles.matrixPane}>
          <ReachMatrix
            snapshot={snapshot}
            rows={rows}
            columns={columns}
            selected={selected}
            onSelect={onSelect}
          />
          {cap === null ? null : (
            <p className={styles.cap} data-testid="reach-cap">
              {cap}
            </p>
          )}
        </div>
        <ReachPanel
          panel={panelOf(snapshot, selected ?? first)}
          opener={props.opener}
        />
      </div>
    );
  }

  return (
    <>
      <div className={styles.bar}>
        <div className={styles.titles}>
          <h2 className={styles.title}>Reachability</h2>
          <p className={styles.caption}>{CAPTION}</p>
        </div>
        <div className={styles.controls}>
          <span className={styles.fieldLabel} aria-hidden="true">
            Namespace
          </span>
          <Select
            label="Namespace"
            hideLabel
            value={namespace}
            options={options}
            onChange={props.onPick}
            testId="reach-namespace"
          />
          {snapshot === null
            ? null
            : countChips(snapshot).map((chip) => (
                <span
                  key={chip.source}
                  className={styles.chip}
                  data-testid={`reach-count-${chip.source}`}
                >
                  <span className={styles.tag} data-source={chip.source}>
                    {chip.tag}
                  </span>{" "}
                  {chip.text}
                </span>
              ))}
          {notEvaluated === null ? null : (
            <Tooltip
              content={notEvaluated.lines.map((line) => (
                <span key={line} className={styles.tipLine}>
                  {line}
                </span>
              ))}
            >
              <button
                type="button"
                className={styles.warnChip}
                data-testid="reach-not-evaluated"
              >
                <TriangleAlert size={12} aria-hidden="true" />
                {notEvaluated.text}
              </button>
            </Tooltip>
          )}
          <Input
            type="search"
            className={styles.filter}
            placeholder="Filter workloads"
            aria-label="Filter workloads"
            data-testid="reach-filter"
            value={query}
            onChange={(e) => setFilter({ namespace, text: e.target.value })}
          />
        </div>
      </div>
      {error === null ? null : (
        <div className={styles.error} role="alert" data-testid="reach-error">
          <TriangleAlert size={16} aria-hidden="true" />
          <span className={styles.errorText}>{error}</span>
          <Button
            size="sm"
            data-testid="reach-retry"
            onClick={() => retryReachability(clusterId, namespace)}
          >
            Retry
          </Button>
        </div>
      )}
      {snapshot === null || snapshot.missing.length === 0 ? null : (
        <div className={styles.banner} role="status" data-testid="reach-banner">
          <TriangleAlert size={16} aria-hidden="true" />
          <div className={styles.bannerLines}>
            {snapshot.missing.map((m) => (
              <p key={m.plural} className={styles.bannerLine}>
                {missingLine(m)}
              </p>
            ))}
          </div>
        </div>
      )}
      <div className={styles.body}>{body}</div>
    </>
  );
}

/**
 * `cluster/:id/network/reachability` (network policies spec §3.2): which workloads of a
 * namespace may talk to which. The namespace lives in `?ns=` (R8); a pick also stays as
 * this cluster's last one. A policy chip opens the policy in the overview drawer.
 */
export function ReachabilityScreen() {
  const { clusterId, resources } = useClusterContext();
  const [params, setParams] = useSearchParams();
  const [filter, , filterRead] = useUiState<string[]>(
    namespaceFilterKey(clusterId),
    NO_NAMESPACES,
  );
  const namespaces = useClusterNamespaces(clusterId);
  const param = params.get("ns");
  // Without `ns`, the start waits for the sidebar filter, which comes first (R8).
  const namespace =
    param !== null && param !== ""
      ? param
      : filterRead
        ? startNamespace(null, filter, storedNamespace(clusterId))
        : null;

  // The start goes into the URL, so the tab keeps it.
  useEffect(() => {
    if (namespace === null || param === namespace) return;
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("ns", namespace);
        return next;
      },
      { replace: true },
    );
  }, [namespace, param, setParams]);

  const onPick = useCallback(
    (picked: string) => {
      storeNamespace(clusterId, picked);
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set("ns", picked);
          return next;
        },
        { replace: true },
      );
    },
    [clusterId, setParams],
  );

  const openable = useMemo(
    () =>
      POLICY_KINDS.flatMap(([group, plural]): ResourceRef[] => {
        const info = findResource(resources, group, plural);
        return info === undefined ? [] : [info.resource];
      }),
    [resources],
  );
  const drawer = useOverviewDrawer(clusterId, resources, openable);
  const { open } = drawer;
  const opener = useCallback<PolicyOpener>(
    (ref: PolicyRef) => {
      const target = policyTarget(ref);
      const kind = openable.find(
        (r) => r.group === target.group && r.plural === target.plural,
      );
      return kind === undefined ? undefined : () => open(kind, target.key);
    },
    [openable, open],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the root only listens for the Escape that closes the drawer, as on list screens.
    <div
      className={styles.screen}
      data-testid="reachability"
      onKeyDown={drawer.onKeyDown}
    >
      {namespace === null ? (
        <Loading />
      ) : (
        <ReachView
          clusterId={clusterId}
          namespace={namespace}
          namespaces={namespaces}
          onPick={onPick}
          opener={opener}
        />
      )}
      {drawer.drawer}
    </div>
  );
}
