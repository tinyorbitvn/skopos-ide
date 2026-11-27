import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fakeAgentPrefs } from "./fakeagent";
import { SSHD_PASSWORD_VAR, SSHD_PORT_VAR, startFakeSshd } from "./fakesshd";
import { startFakeKube } from "./fakekube";
import { findHelm } from "./helmCharts";
import { kubectl } from "./kube";

/** Unreachable, so nothing in these specs ever depends on a live cluster. */
const DEAD_SERVER = "http://127.0.0.1:1";

/** A kubeconfig with one context per name, all pointing at `server`. */
export function kubeconfig(contexts: string[], server = DEAD_SERVER): string {
  const items = (section: string, body: (name: string) => string[]) =>
    [
      `${section}:`,
      ...contexts.flatMap((name) => [`- name: ${name}`, ...body(name)]),
    ].join("\n");
  return `${[
    "apiVersion: v1",
    "kind: Config",
    items("clusters", () => ["  cluster:", `    server: ${server}`]),
    items("users", () => ["  user:", "    token: e2e-token"]),
    items("contexts", (name) => [
      "  context:",
      `    cluster: ${name}`,
      `    user: ${name}`,
    ]),
  ].join("\n")}\n`;
}

export interface SpecFixture {
  /** Files written under `<home>/.kube/` before the app starts. */
  kubeconfigs: Record<string, string>;
  /** Specs in one group share a temp HOME and config dir, so a later spec sees what an earlier one saved. */
  envGroup?: string;
  /**
   * Starts what the spec needs before the app does, such as a fake API server,
   * and returns the kubeconfigs it wants written, with a way to stop it.
   */
  start?: () => Promise<{
    kubeconfigs: Record<string, string>;
    /** Saved as the app's preferences before it starts; see `prepareAppEnv`. */
    prefs?: Record<string, unknown>;
    stop(): Promise<void>;
  }>;
}

const KIND_KUBECONFIG = path.resolve(__dirname, "..", ".tmp", "kubeconfig");

/** One file each for the kind cluster, a fakekube context and a dead one. */
async function startConnectionFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-fake-"));
  const fakePath = path.join(dir, "fake");
  const fake = await startFakeKube({
    kubeconfigPath: fakePath,
    context: "fake",
  });
  return {
    kubeconfigs: {
      kind: fs.readFileSync(KIND_KUBECONFIG, "utf8"),
      fake: fs.readFileSync(fakePath, "utf8"),
      dead: kubeconfig(["dead"]),
    },
    async stop() {
      await fake.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One fakekube context and nothing else, so it needs no Docker. */
async function startSmokeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-smoke-"));
  const fakePath = path.join(dir, "fake");
  const fake = await startFakeKube({
    kubeconfigPath: fakePath,
    context: "fake",
  });
  return {
    kubeconfigs: { fake: fs.readFileSync(fakePath, "utf8") },
    async stop() {
      await fake.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Where the exec consent spec's plugin leaves a file when it runs. */
export const EXEC_CONSENT_MARKER = path.resolve(
  __dirname,
  "..",
  ".tmp",
  "exec-consent-plugin-ran",
);

/**
 * One fakekube context whose user signs in through an exec plugin. The plugin
 * leaves `EXEC_CONSENT_MARKER` behind and prints a token.
 */
async function startExecConsentFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-exec-"));
  const fake = await startFakeKube({
    kubeconfigPath: path.join(dir, "fake"),
    context: "fake",
  });
  fs.mkdirSync(path.dirname(EXEC_CONSENT_MARKER), { recursive: true });
  fs.rmSync(EXEC_CONSENT_MARKER, { force: true });
  const credential = JSON.stringify({
    apiVersion: "client.authentication.k8s.io/v1",
    kind: "ExecCredential",
    status: { token: "from-plugin" },
  });
  const script = `touch '${EXEC_CONSENT_MARKER}'; echo '${credential}'`;
  const config = `${[
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    "- name: exec-plugin",
    "  cluster:",
    `    server: ${fake.url}`,
    "users:",
    "- name: exec-plugin",
    "  user:",
    "    exec:",
    "      apiVersion: client.authentication.k8s.io/v1",
    "      command: /bin/sh",
    `      args: ["-c", ${JSON.stringify(script)}]`,
    "      interactiveMode: Never",
    "contexts:",
    "- name: exec-plugin",
    "  context:",
    "    cluster: exec-plugin",
    "    user: exec-plugin",
  ].join("\n")}\n`;
  return {
    kubeconfigs: { "exec-plugin": config },
    async stop() {
      await fake.stop();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(EXEC_CONSENT_MARKER, { force: true });
    },
  };
}

/** The kind cluster and nothing else. */
async function startKindFixture() {
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    async stop() {},
  };
}

/**
 * The kind cluster, and helm: on PATH it needs nothing more, else the managed copy
 * is set as `helmPath` in the preferences. `findHelm` throws when there is neither.
 */
async function startHelmFixture() {
  const helm = findHelm();
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    prefs: helm.onPath ? undefined : { helmPath: helm.path },
    async stop() {},
  };
}

/** The kind cluster and the scripted agent as the default agent, which runs natively. */
async function startAgentsFixture() {
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    prefs: fakeAgentPrefs(),
    async stop() {},
  };
}

/** The smoke fixture's fake cluster and the scripted agent as the default agent. */
async function startSmokeAgentFixture() {
  const smoke = await startSmokeFixture();
  return { ...smoke, prefs: fakeAgentPrefs() };
}

const MAP_NAMESPACE = "skopos-e2e-map";
// The map's Argo CD objects, in a namespace of their own as Argo CD's are.
const MAP_ARGO_NAMESPACE = "skopos-e2e-map-argocd";
// Cluster-scoped, so deleting the namespace leaves it: it is deleted on its own.
const MAP_CLUSTER_ROLE_BINDING = "skopos-e2e-map-web-view";
const MAP_OBJECTS = path.resolve(__dirname, "..", "fixtures", "map.yaml");
const GATEWAY_API_CRDS =
  "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml";

/**
 * The kind cluster with the resource map's objects (spec E §18.3), with its network
 * policies and Argo CD objects (spec §3.3). The graph reads discovery once, when it
 * starts, so the CRDs (Gateway API here; Cilium and Argo CD from scripts/kind-up.sh) and
 * the objects are in place before the app connects. The CRDs stay installed, as the
 * backend's kind test leaves them; the namespaces and the ClusterRoleBinding are deleted
 * when the run ends.
 */
async function startMapFixture() {
  await kubectl([
    "apply",
    "--server-side",
    "--force-conflicts",
    "--field-manager=skopos-e2e",
    "-f",
    GATEWAY_API_CRDS,
  ]);
  await kubectl([
    "wait",
    "--for=condition=Established",
    "--timeout=60s",
    "crd/gatewayclasses.gateway.networking.k8s.io",
    "crd/gateways.gateway.networking.k8s.io",
    "crd/httproutes.gateway.networking.k8s.io",
    // The sidebar's Network section lists these as well (spec M31).
    "crd/listenersets.gateway.networking.k8s.io",
    "crd/tlsroutes.gateway.networking.k8s.io",
    "crd/tcproutes.gateway.networking.k8s.io",
    "crd/udproutes.gateway.networking.k8s.io",
    "crd/backendtlspolicies.gateway.networking.k8s.io",
  ]);
  // Installed by scripts/kind-up.sh; the map draws these kinds (spec §3.3).
  await kubectl([
    "wait",
    "--for=condition=Established",
    "--timeout=60s",
    "crd/ciliumnetworkpolicies.cilium.io",
    "crd/appprojects.argoproj.io",
    "crd/applications.argoproj.io",
  ]);
  for (const namespace of [MAP_NAMESPACE, MAP_ARGO_NAMESPACE]) {
    await kubectl([
      "delete",
      "namespace",
      namespace,
      "--ignore-not-found",
      "--wait=true",
      "--timeout=120s",
    ]);
  }
  await kubectl([
    "delete",
    "clusterrolebinding",
    MAP_CLUSTER_ROLE_BINDING,
    "--ignore-not-found",
  ]);
  await kubectl(["apply", "-f", MAP_OBJECTS]);
  await kubectl([
    "-n",
    MAP_NAMESPACE,
    "rollout",
    "status",
    "deployment/web",
    "--timeout=120s",
  ]);
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    async stop() {
      for (const namespace of [MAP_NAMESPACE, MAP_ARGO_NAMESPACE]) {
        await kubectl([
          "delete",
          "namespace",
          namespace,
          "--ignore-not-found",
          "--wait=false",
        ]);
      }
      await kubectl([
        "delete",
        "clusterrolebinding",
        MAP_CLUSTER_ROLE_BINDING,
        "--ignore-not-found",
      ]);
    },
  };
}

const TOPOLOGY_NAMESPACE = "skopos-e2e-topology";
const TOPOLOGY_OBJECTS = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "topology.yaml",
);
const TOPOLOGY_WORKER = "skopos-e2e-worker";
const TOPOLOGY_ZONE_LABEL = "topology.kubernetes.io/zone";

/**
 * The kind cluster with two pods of a Deployment on the worker, which gets a zone label so
 * the page draws a zone column (topology spec §8). The namespace and the label go when the
 * run ends.
 */
async function startTopologyFixture() {
  await kubectl([
    "delete",
    "namespace",
    TOPOLOGY_NAMESPACE,
    "--ignore-not-found",
    "--wait=true",
    "--timeout=120s",
  ]);
  await kubectl([
    "label",
    "node",
    TOPOLOGY_WORKER,
    `${TOPOLOGY_ZONE_LABEL}=skopos-e2e-zone`,
    "--overwrite",
  ]);
  await kubectl(["apply", "-f", TOPOLOGY_OBJECTS]);
  await kubectl([
    "-n",
    TOPOLOGY_NAMESPACE,
    "rollout",
    "status",
    "deployment/topology",
    "--timeout=120s",
  ]);
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    async stop() {
      await kubectl([
        "delete",
        "namespace",
        TOPOLOGY_NAMESPACE,
        "--ignore-not-found",
        "--wait=false",
      ]);
      await kubectl([
        "label",
        "node",
        TOPOLOGY_WORKER,
        `${TOPOLOGY_ZONE_LABEL}-`,
      ]).catch(() => "");
    },
  };
}

const REACH_NAMESPACES = [
  "skopos-e2e-reach",
  "skopos-e2e-reach-ingress",
  "skopos-e2e-reach-monitoring",
];
// Cluster-scoped, so deleting the namespaces leaves it: it is deleted on its own.
const REACH_CLUSTERWIDE_POLICY = "skopos-e2e-reach-allow-prometheus-scrape";
const REACH_OBJECTS = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "reachability.yaml",
);

/**
 * The kind cluster with the Reachability page's sample namespace (network policies
 * contract C13). scripts/kind-up.sh installs the Cilium CRDs; the policies need them
 * established. The namespaces and the cluster-wide policy go when the run ends.
 */
async function startReachabilityFixture() {
  await kubectl([
    "wait",
    "--for=condition=Established",
    "--timeout=60s",
    "crd/ciliumnetworkpolicies.cilium.io",
    "crd/ciliumclusterwidenetworkpolicies.cilium.io",
  ]);
  await kubectl([
    "delete",
    "namespace",
    ...REACH_NAMESPACES,
    "--ignore-not-found",
    "--wait=true",
    "--timeout=120s",
  ]);
  await kubectl([
    "delete",
    "ciliumclusterwidenetworkpolicies.cilium.io",
    REACH_CLUSTERWIDE_POLICY,
    "--ignore-not-found",
  ]);
  await kubectl(["apply", "-f", REACH_OBJECTS]);
  for (const [namespace, workload] of [
    ["skopos-e2e-reach", "deployment/web"],
    ["skopos-e2e-reach", "deployment/api"],
    ["skopos-e2e-reach", "deployment/worker"],
    ["skopos-e2e-reach", "statefulset/db"],
    ["skopos-e2e-reach-ingress", "deployment/ingress-nginx-controller"],
    ["skopos-e2e-reach-monitoring", "deployment/prometheus"],
  ]) {
    await kubectl([
      "-n",
      namespace,
      "rollout",
      "status",
      workload,
      "--timeout=120s",
    ]);
  }
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    async stop() {
      await kubectl([
        "delete",
        "namespace",
        ...REACH_NAMESPACES,
        "--ignore-not-found",
        "--wait=false",
      ]);
      await kubectl([
        "delete",
        "ciliumclusterwidenetworkpolicies.cilium.io",
        REACH_CLUSTERWIDE_POLICY,
        "--ignore-not-found",
      ]);
    },
  };
}

/**
 * A local update server that offers 99.0.0, which the e2e build asks instead of GitHub
 * (in-app update spec §8). Nothing is downloaded, so the addresses and signatures are
 * never used.
 */
async function startUpdatesFixture() {
  const file = "http://127.0.0.1:1/never-downloaded";
  const platform = { signature: "unused", url: file };
  const manifest = {
    version: "99.0.0",
    notes: "- Faster lists\n- Fewer clicks",
    pub_date: "2026-11-25T12:00:00Z",
    platforms: {
      "linux-x86_64": platform,
      "darwin-aarch64": platform,
      "darwin-x86_64": platform,
      "windows-x86_64": platform,
    },
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/latest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The app inherits this environment from the launcher, which starts it next.
  process.env.SKOPOS_E2E_UPDATE_ENDPOINT = `http://127.0.0.1:${port}/latest.json`;
  return {
    kubeconfigs: {},
    async stop() {
      delete process.env.SKOPOS_E2E_UPDATE_ENDPOINT;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const KIND_INTERNAL_SERVER = "skopos-e2e-control-plane:6443";
const SSH_CONFIG_VAR = "SKOPOS_E2E_SSH_CONFIG";

/**
 * The kind cluster behind an SSH tunnel (tunnels spec §6.6). Its kubeconfig names the API
 * server as inside the kind network, which this host cannot resolve; only skopos-fakesshd
 * resolves it, to the address kind publishes, so the cluster answers through the tunnel
 * alone. ssh finds the account's home from the system, not from HOME, so the e2e build
 * passes this fixture's config to ssh (`SKOPOS_E2E_SSH_CONFIG`) and ssh never reads ~/.ssh.
 * Its known_hosts starts empty: the spec trusts the host key in the prompt dialog.
 */
async function startTunnelsFixture() {
  const kind = fs.readFileSync(KIND_KUBECONFIG, "utf8");
  const published = /server: https:\/\/(127\.0\.0\.1:\d+)/.exec(kind)?.[1];
  if (published === undefined) {
    throw new Error(`${KIND_KUBECONFIG} names no https://127.0.0.1:<port> server`);
  }
  const password = `e2e-${process.pid}`;
  const sshd = await startFakeSshd({
    user: "me",
    password,
    hosts: { [KIND_INTERNAL_SERVER]: published },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-ssh-"));
  const knownHosts = path.join(dir, "known_hosts");
  const globalKnownHosts = path.join(dir, "global_known_hosts");
  fs.writeFileSync(knownHosts, "");
  fs.writeFileSync(globalKnownHosts, "");
  const config = path.join(dir, "ssh_config");
  fs.writeFileSync(
    config,
    [
      "Host *",
      `  UserKnownHostsFile "${knownHosts}"`,
      `  GlobalKnownHostsFile "${globalKnownHosts}"`,
      "  HashKnownHosts no",
      "  IdentityAgent none",
      "  PubkeyAuthentication no",
      "  IdentitiesOnly yes",
      "  PreferredAuthentications keyboard-interactive,password",
      "  StrictHostKeyChecking ask",
      "  UpdateHostKeys no",
      "  ConnectTimeout 5",
      "",
    ].join("\n"),
  );
  // The app and the spec inherit these from the launcher, which starts them next. Later
  // specs inherit them too; only SSH tunnels read them.
  process.env[SSH_CONFIG_VAR] = config;
  process.env[SSHD_PORT_VAR] = String(sshd.port);
  process.env[SSHD_PASSWORD_VAR] = password;
  return {
    kubeconfigs: {
      kind: kind.replace(
        `server: https://${published}`,
        `server: https://${KIND_INTERNAL_SERVER}`,
      ),
    },
    async stop() {
      for (const name of [SSH_CONFIG_VAR, SSHD_PORT_VAR, SSHD_PASSWORD_VAR]) {
        delete process.env[name];
      }
      await sshd.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const FIXTURES: Record<string, SpecFixture> = {
  catalog: { kubeconfigs: { config: kubeconfig(["alpha", "beta"]) } },
  "hotbar-restart-1-save": {
    kubeconfigs: { config: kubeconfig(["alpha", "beta"]) },
    envGroup: "hotbar-restart",
  },
  "hotbar-restart-2-verify": { kubeconfigs: {}, envGroup: "hotbar-restart" },
  connection: { kubeconfigs: {}, start: startConnectionFixture },
  smoke: { kubeconfigs: {}, start: startSmokeFixture },
  "exec-consent": { kubeconfigs: {}, start: startExecConsentFixture },
  resources: { kubeconfigs: {}, start: startKindFixture },
  editor: { kubeconfigs: {}, start: startKindFixture },
  crd: { kubeconfigs: {}, start: startKindFixture },
  kinds: { kubeconfigs: {}, start: startKindFixture },
  drawer: { kubeconfigs: {}, start: startKindFixture },
  "config-kinds": { kubeconfigs: {}, start: startKindFixture },
  "workloads-overview": { kubeconfigs: {}, start: startKindFixture },
  "section-overviews": { kubeconfigs: {}, start: startKindFixture },
  drain: { kubeconfigs: {}, start: startKindFixture },
  actions: { kubeconfigs: {}, start: startKindFixture },
  argocd: { kubeconfigs: {}, start: startKindFixture },
  logs: { kubeconfigs: {}, start: startKindFixture },
  "dock-restart-1-save": {
    kubeconfigs: {},
    envGroup: "dock-restart",
    start: startKindFixture,
  },
  "dock-restart-2-verify": { kubeconfigs: {}, envGroup: "dock-restart" },
  terminal: { kubeconfigs: {}, start: startKindFixture },
  "terminal-restart-1-save": {
    kubeconfigs: {},
    envGroup: "terminal-restart",
    start: startKindFixture,
  },
  "terminal-restart-2-verify": {
    kubeconfigs: {},
    envGroup: "terminal-restart",
  },
  "port-forward": { kubeconfigs: {}, start: startKindFixture },
  "cert-users": { kubeconfigs: {}, start: startKindFixture },
  "app-shell": { kubeconfigs: {}, start: startKindFixture },
  "port-forward-restart-1-save": {
    kubeconfigs: {},
    envGroup: "port-forward-restart",
    start: startKindFixture,
  },
  "port-forward-restart-2-verify": {
    kubeconfigs: {},
    envGroup: "port-forward-restart",
  },
  screens: { kubeconfigs: {}, start: startKindFixture },
  helm: { kubeconfigs: {}, start: startHelmFixture },
  agents: { kubeconfigs: {}, start: startAgentsFixture },
  agent: { kubeconfigs: {}, start: startSmokeAgentFixture },
  // e2e/helpers/metrics.ts installs the providers in the spec, which needs a longer timeout.
  metrics: { kubeconfigs: {}, start: startKindFixture },
  map: { kubeconfigs: {}, start: startMapFixture },
  topology: { kubeconfigs: {}, start: startTopologyFixture },
  reachability: { kubeconfigs: {}, start: startReachabilityFixture },
  tabs: { kubeconfigs: {}, start: startKindFixture },
  "sidebar-rail": { kubeconfigs: {}, start: startKindFixture },
  "tabs-restart-1-save": {
    kubeconfigs: {},
    envGroup: "tabs-restart",
    start: startKindFixture,
  },
  "tabs-restart-2-verify": { kubeconfigs: {}, envGroup: "tabs-restart" },
  windows: { kubeconfigs: {}, start: startKindFixture },
  updates: { kubeconfigs: {}, start: startUpdatesFixture },
  tunnels: { kubeconfigs: {}, start: startTunnelsFixture },
  "catalog-folders": {
    kubeconfigs: { config: kubeconfig(["alpha", "beta", "gamma"]) },
  },
};

/** Specs with no entry start with an empty `~/.kube`. */
export function fixtureFor(specFile: string): SpecFixture {
  const name = path.basename(specFile.replace(/^file:\/\//, ""), ".e2e.ts");
  return FIXTURES[name] ?? { kubeconfigs: {} };
}
