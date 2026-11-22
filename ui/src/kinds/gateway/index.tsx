import { Badge } from "../../design";
import type { TableColumn } from "../../design/VirtualTable";
import { baseColumns, textColumn } from "../columns";
import type { KubeObject } from "../objects";
import { registerKind } from "../registry";
import {
  conditionStatus,
  gatewayAddress,
  listenerSetParent,
  NONE,
  policyTargets,
  routeHostnames,
  routeParents,
} from "./gateway";

const GROUP = "gateway.networking.k8s.io";

/** A condition's status in a Badge, or "—" without it. */
function conditionColumn(
  id: string,
  header: string,
  type: string,
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: 120,
    sortValue: (o) => conditionStatus(o, type)?.label ?? "",
    filter: { text: (o) => conditionStatus(o, type)?.label ?? null },
    render: (o) => {
      const status = conditionStatus(o, type);
      return status ? <Badge tone={status.tone}>{status.label}</Badge> : NONE;
    },
  };
}

/** A text cell that is never empty: the helpers give "—" for nothing. */
function listColumn(
  id: string,
  header: string,
  get: (o: KubeObject) => string,
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: "minmax(120px, 1fr)",
    sortValue: get,
    filter: {
      text: (o) => {
        const text = get(o);
        return text === NONE || text === "" ? null : text;
      },
    },
    render: (o) => <span title={get(o)}>{get(o)}</span>,
  };
}

/** A BackendTLSPolicy's `spec.validation.hostname`, or "—". */
function validationHostname(o: KubeObject): string {
  const hostname = o.spec?.validation?.hostname;
  return typeof hostname === "string" && hostname !== "" ? hostname : NONE;
}

// The Gateway API kinds are listed under Network (spec G §3.2, M2). Every other kind of
// the two groups keeps its CRD's printer columns, and ReferenceGrant the defaults.
registerKind(GROUP, "gatewayclasses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("controller", "Controller", (o) => o.spec?.controllerName),
      conditionColumn("accepted", "Accepted", "Accepted"),
    ),
});

registerKind(GROUP, "gateways", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("class", "Class", (o) => o.spec?.gatewayClassName),
      listColumn("address", "Address", gatewayAddress),
      conditionColumn("programmed", "Programmed", "Programmed"),
    ),
});

registerKind(GROUP, "httproutes", {
  columns: (info) =>
    baseColumns(
      info.resource,
      listColumn("hostnames", "Hostnames", routeHostnames),
      listColumn("parents", "Parents", routeParents),
    ),
});

registerKind(GROUP, "grpcroutes", {
  columns: (info) =>
    baseColumns(
      info.resource,
      listColumn("hostnames", "Hostnames", routeHostnames),
      listColumn("parents", "Parents", routeParents),
    ),
});

registerKind(GROUP, "tlsroutes", {
  columns: (info) =>
    baseColumns(
      info.resource,
      listColumn("hostnames", "Hostnames", routeHostnames),
      listColumn("parents", "Parents", routeParents),
    ),
});

registerKind(GROUP, "tcproutes", {
  columns: (info) =>
    baseColumns(info.resource, listColumn("parents", "Parents", routeParents)),
});

registerKind(GROUP, "udproutes", {
  columns: (info) =>
    baseColumns(info.resource, listColumn("parents", "Parents", routeParents)),
});

registerKind(GROUP, "listenersets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      listColumn("parent", "Parent", listenerSetParent),
      conditionColumn("accepted", "Accepted", "Accepted"),
      conditionColumn("programmed", "Programmed", "Programmed"),
    ),
});

registerKind(GROUP, "backendtlspolicies", {
  columns: (info) =>
    baseColumns(
      info.resource,
      listColumn("targets", "Targets", policyTargets),
      listColumn("hostname", "Hostname", validationHostname),
    ),
});
