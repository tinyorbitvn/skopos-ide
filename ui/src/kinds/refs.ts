import type { ResourceRef } from "../ipc/generated/ResourceRef";

export const PODS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
export const JOBS: ResourceRef = {
  group: "batch",
  version: "v1",
  plural: "jobs",
  kind: "Job",
  namespaced: true,
};
export const CRONJOBS: ResourceRef = {
  group: "batch",
  version: "v1",
  plural: "cronjobs",
  kind: "CronJob",
  namespaced: true,
};
export const DEPLOYMENTS: ResourceRef = {
  group: "apps",
  version: "v1",
  plural: "deployments",
  kind: "Deployment",
  namespaced: true,
};
export const REPLICASETS: ResourceRef = {
  group: "apps",
  version: "v1",
  plural: "replicasets",
  kind: "ReplicaSet",
  namespaced: true,
};
export const CONFIGMAPS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "configmaps",
  kind: "ConfigMap",
  namespaced: true,
};
export const SECRETS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "secrets",
  kind: "Secret",
  namespaced: true,
};
export const ENDPOINT_SLICES: ResourceRef = {
  group: "discovery.k8s.io",
  version: "v1",
  plural: "endpointslices",
  kind: "EndpointSlice",
  namespaced: true,
};
export const RESOURCE_QUOTAS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "resourcequotas",
  kind: "ResourceQuota",
  namespaced: true,
};
export const NODES: ResourceRef = {
  group: "",
  version: "v1",
  plural: "nodes",
  kind: "Node",
  namespaced: false,
};
export const STORAGE_CLASSES: ResourceRef = {
  group: "storage.k8s.io",
  version: "v1",
  plural: "storageclasses",
  kind: "StorageClass",
  namespaced: false,
};

export const NAMESPACES: ResourceRef = {
  group: "",
  version: "v1",
  plural: "namespaces",
  kind: "Namespace",
  namespaced: false,
};

const RBAC = "rbac.authorization.k8s.io";

export const CLUSTER_ROLE_BINDINGS: ResourceRef = {
  group: RBAC,
  version: "v1",
  plural: "clusterrolebindings",
  kind: "ClusterRoleBinding",
  namespaced: false,
};
export const ROLE_BINDINGS: ResourceRef = {
  group: RBAC,
  version: "v1",
  plural: "rolebindings",
  kind: "RoleBinding",
  namespaced: true,
};
export const CLUSTER_ROLES: ResourceRef = {
  group: RBAC,
  version: "v1",
  plural: "clusterroles",
  kind: "ClusterRole",
  namespaced: false,
};
export const ROLES: ResourceRef = {
  group: RBAC,
  version: "v1",
  plural: "roles",
  kind: "Role",
  namespaced: true,
};
