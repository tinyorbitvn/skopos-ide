import type { KubeObject } from "../kinds/objects";

/**
 * Whole objects and the rows the list watch sends of them, for the kinds whose rows
 * the backend trims here: what a row keeps is `APPLICATION_ROW` and `EVENT_ROW` in the
 * core's `resources/trim.rs`. A reader of list rows must give the same answer for
 * both; keep these the same as the rules.
 */
const metadata = {
  uid: "u-1",
  resourceVersion: "42",
  creationTimestamp: "2026-11-01T08:00:00Z",
  labels: { app: "shop" },
  annotations: { note: "kept" },
};

export const WHOLE_APPLICATION = {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Application",
  metadata: { ...metadata, name: "shop", namespace: "apps" },
  operation: { sync: { revision: "abc1234" } },
  spec: {
    project: "team-a",
    sources: [
      { repoURL: "https://example.com/shop.git", path: "deploy" },
      { repoURL: "https://example.com/values.git", ref: "values" },
    ],
    destination: {
      server: "https://kubernetes.default.svc",
      namespace: "shop",
    },
    syncPolicy: {
      automated: { prune: true, selfHeal: false },
      syncOptions: ["CreateNamespace=true"],
    },
  },
  status: {
    controllerNamespace: "argocd",
    sync: {
      status: "OutOfSync",
      revision: "abc1234def",
      revisions: ["abc1234def", "0123456789"],
      comparedTo: { source: { repoURL: "https://example.com/shop.git" } },
    },
    health: { status: "Degraded", message: "a pod is failing" },
    resources: [{ kind: "Deployment", name: "web", namespace: "shop" }],
    conditions: [{ type: "SyncError", message: "boom" }],
    history: [
      {
        id: 1,
        revision: "1111111aaa",
        deployedAt: "2026-11-01T08:10:00Z",
        initiatedBy: { username: "admin" },
        source: { repoURL: "https://example.com/shop.git" },
      },
      {
        id: 2,
        revisions: ["2222222bbb", "0123456789"],
        deployedAt: "2026-11-01T09:10:00Z",
        initiatedBy: { automated: true },
        sources: [{ repoURL: "https://example.com/shop.git" }],
      },
    ],
    operationState: {
      phase: "Running",
      message: "waiting",
      startedAt: "2026-11-01T09:20:00Z",
      syncResult: { resources: [{ kind: "Deployment", name: "web" }] },
    },
  },
} satisfies KubeObject;

export const APPLICATION_ROW = {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Application",
  metadata: { ...metadata, name: "shop", namespace: "apps" },
  operation: {},
  spec: {
    project: "team-a",
    sources: [{}, {}],
    syncPolicy: { automated: { prune: true, selfHeal: false } },
  },
  status: {
    controllerNamespace: "argocd",
    sync: {
      status: "OutOfSync",
      revision: "abc1234def",
      revisions: ["abc1234def", "0123456789"],
    },
    health: { status: "Degraded" },
    history: [
      {
        id: 1,
        revision: "1111111aaa",
        deployedAt: "2026-11-01T08:10:00Z",
        initiatedBy: { username: "admin" },
      },
      {
        id: 2,
        revisions: ["2222222bbb", "0123456789"],
        deployedAt: "2026-11-01T09:10:00Z",
        initiatedBy: { automated: true },
      },
    ],
    operationState: { phase: "Running" },
  },
} satisfies KubeObject;

export const WHOLE_EVENT = {
  apiVersion: "v1",
  kind: "Event",
  metadata: { ...metadata, name: "web-1.17f", namespace: "shop" },
  type: "Warning",
  reason: "BackOff",
  message: "Back-off restarting failed container",
  count: 4,
  series: { count: 9, lastObservedTime: "2026-11-01T10:05:00.000000Z" },
  firstTimestamp: "2026-11-01T10:00:00Z",
  lastTimestamp: "2026-11-01T10:04:00Z",
  eventTime: "2026-11-01T10:00:00.000000Z",
  involvedObject: {
    apiVersion: "v1",
    kind: "Pod",
    name: "web-1",
    namespace: "shop",
    uid: "u-p",
    fieldPath: "spec.containers{app}",
  },
  source: { component: "kubelet", host: "node-1" },
  reportingComponent: "kubelet",
} satisfies KubeObject;

export const EVENT_ROW = {
  apiVersion: "v1",
  kind: "Event",
  metadata: { ...metadata, name: "web-1.17f", namespace: "shop" },
  type: "Warning",
  reason: "BackOff",
  message: "Back-off restarting failed container",
  count: 4,
  series: { count: 9, lastObservedTime: "2026-11-01T10:05:00.000000Z" },
  firstTimestamp: "2026-11-01T10:00:00Z",
  lastTimestamp: "2026-11-01T10:04:00Z",
  eventTime: "2026-11-01T10:00:00.000000Z",
  involvedObject: {
    apiVersion: "v1",
    kind: "Pod",
    name: "web-1",
    namespace: "shop",
  },
} satisfies KubeObject;
