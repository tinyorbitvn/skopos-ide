export type TemplateGroup =
  | "workloads"
  | "network"
  | "config"
  | "storage"
  | "access"
  | "cluster";

/** The template groups, in menu order (spec T2). */
export const TEMPLATE_GROUPS: { id: TemplateGroup; label: string }[] = [
  { id: "workloads", label: "Workloads" },
  { id: "network", label: "Network" },
  { id: "config", label: "Config" },
  { id: "storage", label: "Storage" },
  { id: "access", label: "Access" },
  { id: "cluster", label: "Cluster" },
];

export interface Template {
  id: string;
  label: string;
  group: TemplateGroup;
  /** The `apiVersion` and `kind` of its document. */
  apiVersion: string;
  kind: string;
  yaml: string;
}

const FILES = import.meta.glob<string>("./yaml/*.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The file names, for the test that pairs them with entries. */
export const TEMPLATE_FILES = Object.keys(FILES);

const ENTRIES: Omit<Template, "yaml">[] = [
  {
    id: "pod",
    label: "Pod",
    group: "workloads",
    apiVersion: "v1",
    kind: "Pod",
  },
  {
    id: "deployment",
    label: "Deployment",
    group: "workloads",
    apiVersion: "apps/v1",
    kind: "Deployment",
  },
  {
    id: "deployment-probes",
    label: "Deployment · probes and resources",
    group: "workloads",
    apiVersion: "apps/v1",
    kind: "Deployment",
  },
  {
    id: "statefulset",
    label: "StatefulSet",
    group: "workloads",
    apiVersion: "apps/v1",
    kind: "StatefulSet",
  },
  {
    id: "daemonset",
    label: "DaemonSet",
    group: "workloads",
    apiVersion: "apps/v1",
    kind: "DaemonSet",
  },
  {
    id: "job",
    label: "Job",
    group: "workloads",
    apiVersion: "batch/v1",
    kind: "Job",
  },
  {
    id: "cronjob",
    label: "CronJob",
    group: "workloads",
    apiVersion: "batch/v1",
    kind: "CronJob",
  },
  {
    id: "horizontalpodautoscaler",
    label: "HorizontalPodAutoscaler",
    group: "workloads",
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
  },
  {
    id: "poddisruptionbudget",
    label: "PodDisruptionBudget",
    group: "workloads",
    apiVersion: "policy/v1",
    kind: "PodDisruptionBudget",
  },
  {
    id: "service",
    label: "Service",
    group: "network",
    apiVersion: "v1",
    kind: "Service",
  },
  {
    id: "service-nodeport",
    label: "Service · NodePort",
    group: "network",
    apiVersion: "v1",
    kind: "Service",
  },
  {
    id: "service-loadbalancer",
    label: "Service · LoadBalancer",
    group: "network",
    apiVersion: "v1",
    kind: "Service",
  },
  {
    id: "service-headless",
    label: "Service · headless",
    group: "network",
    apiVersion: "v1",
    kind: "Service",
  },
  {
    id: "ingress",
    label: "Ingress",
    group: "network",
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
  },
  {
    id: "ingress-tls",
    label: "Ingress · TLS",
    group: "network",
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
  },
  {
    id: "networkpolicy",
    label: "NetworkPolicy",
    group: "network",
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
  },
  {
    id: "networkpolicy-default-deny",
    label: "NetworkPolicy · default deny",
    group: "network",
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
  },
  {
    id: "gateway",
    label: "Gateway",
    group: "network",
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "Gateway",
  },
  {
    id: "httproute",
    label: "HTTPRoute",
    group: "network",
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
  },
  {
    id: "configmap",
    label: "ConfigMap",
    group: "config",
    apiVersion: "v1",
    kind: "ConfigMap",
  },
  {
    id: "secret",
    label: "Secret",
    group: "config",
    apiVersion: "v1",
    kind: "Secret",
  },
  {
    id: "secret-docker-registry",
    label: "Secret · docker-registry",
    group: "config",
    apiVersion: "v1",
    kind: "Secret",
  },
  {
    id: "secret-tls",
    label: "Secret · TLS",
    group: "config",
    apiVersion: "v1",
    kind: "Secret",
  },
  {
    id: "secret-basic-auth",
    label: "Secret · basic-auth",
    group: "config",
    apiVersion: "v1",
    kind: "Secret",
  },
  {
    id: "persistentvolumeclaim",
    label: "PersistentVolumeClaim",
    group: "storage",
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
  },
  {
    id: "persistentvolume",
    label: "PersistentVolume",
    group: "storage",
    apiVersion: "v1",
    kind: "PersistentVolume",
  },
  {
    id: "storageclass",
    label: "StorageClass",
    group: "storage",
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
  },
  {
    id: "serviceaccount",
    label: "ServiceAccount",
    group: "access",
    apiVersion: "v1",
    kind: "ServiceAccount",
  },
  {
    id: "role",
    label: "Role",
    group: "access",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
  },
  {
    id: "rolebinding",
    label: "RoleBinding",
    group: "access",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
  },
  {
    id: "clusterrole",
    label: "ClusterRole",
    group: "access",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
  },
  {
    id: "clusterrolebinding",
    label: "ClusterRoleBinding",
    group: "access",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
  },
  {
    id: "namespace",
    label: "Namespace",
    group: "cluster",
    apiVersion: "v1",
    kind: "Namespace",
  },
  {
    id: "resourcequota",
    label: "ResourceQuota",
    group: "cluster",
    apiVersion: "v1",
    kind: "ResourceQuota",
  },
  {
    id: "limitrange",
    label: "LimitRange",
    group: "cluster",
    apiVersion: "v1",
    kind: "LimitRange",
  },
  {
    id: "priorityclass",
    label: "PriorityClass",
    group: "cluster",
    apiVersion: "scheduling.k8s.io/v1",
    kind: "PriorityClass",
  },
];

/** What the create tab can start from, in menu order. No namespace: the tab supplies one. */
export const TEMPLATES: Template[] = ENTRIES.flatMap((entry) => {
  const yaml = FILES[`./yaml/${entry.id}.yaml`];
  return yaml === undefined ? [] : [{ ...entry, yaml }];
});
