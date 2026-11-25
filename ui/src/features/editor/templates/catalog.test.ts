import { expect, test } from "vitest";
import { parseAllDocuments } from "yaml";
import { TEMPLATE_FILES, TEMPLATE_GROUPS, TEMPLATES } from "./catalog";

const ORDER: Record<string, string[]> = {
  workloads: [
    "Pod",
    "Deployment",
    "Deployment · probes and resources",
    "StatefulSet",
    "DaemonSet",
    "Job",
    "CronJob",
    "HorizontalPodAutoscaler",
    "PodDisruptionBudget",
  ],
  network: [
    "Service",
    "Service · NodePort",
    "Service · LoadBalancer",
    "Service · headless",
    "Ingress",
    "Ingress · TLS",
    "NetworkPolicy",
    "NetworkPolicy · default deny",
    "Gateway",
    "HTTPRoute",
  ],
  config: [
    "ConfigMap",
    "Secret",
    "Secret · docker-registry",
    "Secret · TLS",
    "Secret · basic-auth",
  ],
  storage: ["PersistentVolumeClaim", "PersistentVolume", "StorageClass"],
  access: [
    "ServiceAccount",
    "Role",
    "RoleBinding",
    "ClusterRole",
    "ClusterRoleBinding",
  ],
  cluster: ["Namespace", "ResourceQuota", "LimitRange", "PriorityClass"],
};

test("groups come in the spec's order, each with its templates in order", () => {
  expect(TEMPLATE_GROUPS.map((g) => g.label)).toEqual([
    "Workloads",
    "Network",
    "Config",
    "Storage",
    "Access",
    "Cluster",
  ]);
  for (const group of TEMPLATE_GROUPS) {
    expect(
      TEMPLATES.filter((t) => t.group === group.id).map((t) => t.label),
      group.id,
    ).toEqual(ORDER[group.id]);
  }
});

test("every file has an entry, every entry a file, and ids are unique", () => {
  const ids = TEMPLATES.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  const files = TEMPLATE_FILES.map((path) =>
    path.replace("./yaml/", "").replace(".yaml", ""),
  );
  expect([...files].sort()).toEqual([...ids].sort());
});

test("each template is one document of its kind, named example, with no namespace", () => {
  for (const template of TEMPLATES) {
    const documents = parseAllDocuments(template.yaml);
    expect(Array.isArray(documents) && documents.length, template.id).toBe(1);
    const [document] = documents as Exclude<typeof documents, { empty: true }>;
    expect(document.errors, template.id).toEqual([]);
    const value = document.toJS() as {
      apiVersion: string;
      kind: string;
      metadata: { name: string; namespace?: string };
    };
    expect(value.apiVersion, template.id).toBe(template.apiVersion);
    expect(value.kind, template.id).toBe(template.kind);
    expect(value.metadata.name, template.id).toBe("example");
    expect(value.metadata.namespace, template.id).toBeUndefined();
  }
});

test("the earlier templates keep their text", () => {
  const pod = TEMPLATES.find((t) => t.id === "pod");
  expect(pod?.yaml).toBe(
    "apiVersion: v1\nkind: Pod\nmetadata:\n  name: example\n  labels:\n    app: example\nspec:\n  containers:\n    - name: main\n      image: registry.k8s.io/pause:3.10\n",
  );
});
