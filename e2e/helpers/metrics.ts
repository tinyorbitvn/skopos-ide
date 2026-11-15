import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findHelm } from "./helmCharts";
import { kubectl } from "./kube";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
/** The kubeconfig of the kind cluster, which `scripts/kind-up.sh` writes. */
const KIND_KUBECONFIG = path.join(REPO_ROOT, "e2e", ".tmp", "kubeconfig");
const METRICS_UP = path.join(REPO_ROOT, "scripts", "metrics-up.sh");
const VALUES = path.join(
  REPO_ROOT,
  "e2e",
  "fixtures",
  "prometheus-values.yaml",
);
const MIMIR_MANIFEST = path.join(REPO_ROOT, "e2e", "fixtures", "mimir.yaml");
/** Where prometheus-values.yaml sends every sample. */
const MIMIR_PUSH_URL = "http://mimir.skopos-e2e-mimir.svc:8080/api/v1/push";
/** helm's own folders, so the user's helm setup is not touched; the chart cache stays for the next run. */
const HELM_HOME = path.join(REPO_ROOT, "e2e", ".tmp", "helm-metrics");
const CHART_REPO = "https://prometheus-community.github.io/helm-charts";
const CHART_VERSION = "29.45.1";
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

export const PROMETHEUS_NAMESPACE = "skopos-e2e-metrics";
export const PROMETHEUS_RELEASE = "skopos-e2e-prometheus";
/** The chart's server Deployment, Pod and Service. */
export const PROMETHEUS_SERVER_SELECTOR = [
  `app.kubernetes.io/instance=${PROMETHEUS_RELEASE}`,
  "app.kubernetes.io/name=prometheus",
  "app.kubernetes.io/component=server",
].join(",");

export interface PrometheusService {
  namespace: string;
  service: string;
  port: number;
}

/** The Mimir fixture (e2e/fixtures/mimir.yaml); its Prometheus API is under /prometheus. */
export const MIMIR: PrometheusService = {
  namespace: "skopos-e2e-mimir",
  service: "mimir",
  port: 8080,
};
/** The tenant the e2e Prometheus writes as. */
export const MIMIR_TENANT = "skopos-tenant-a";

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: REPO_ROOT, env, maxBuffer: OUTPUT_LIMIT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${path.basename(file)} ${args.join(" ")}: ${stderr || error.message}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function helmEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HELM_CACHE_HOME: path.join(HELM_HOME, "cache"),
    HELM_CONFIG_HOME: path.join(HELM_HOME, "config"),
    HELM_DATA_HOME: path.join(HELM_HOME, "data"),
  };
}

async function metricsServerServed(): Promise<boolean> {
  try {
    const status = await kubectl([
      "get",
      "apiservice",
      "v1beta1.metrics.k8s.io",
      "-o",
      'jsonpath={.status.conditions[?(@.type=="Available")].status}',
    ]);
    return status.trim() === "True";
  } catch {
    // Not registered yet.
    return false;
  }
}

/** The release's status, such as "deployed" or "failed", or null when there is none. */
async function releaseStatus(helm: string): Promise<string | null> {
  try {
    const out = await run(
      helm,
      [
        "status",
        PROMETHEUS_RELEASE,
        "-n",
        PROMETHEUS_NAMESPACE,
        "--kubeconfig",
        KIND_KUBECONFIG,
        "-o",
        "json",
      ],
      helmEnv(),
    );
    const release = JSON.parse(out) as { info?: { status?: string } };
    return release.info?.status ?? null;
  } catch {
    // helm status fails when the release does not exist.
    return null;
  }
}

/** Whether the release's values send every sample to Mimir. A release from before the Mimir fixture does not. */
async function writesToMimir(helm: string): Promise<boolean> {
  const out = await run(
    helm,
    [
      "get",
      "values",
      PROMETHEUS_RELEASE,
      "-n",
      PROMETHEUS_NAMESPACE,
      "--kubeconfig",
      KIND_KUBECONFIG,
      "-o",
      "json",
    ],
    helmEnv(),
  );
  const values = JSON.parse(out) as {
    server?: { remoteWrite?: { url?: string }[] };
  };
  return (values.server?.remoteWrite ?? []).some(
    (write) => write.url === MIMIR_PUSH_URL,
  );
}

async function ensurePrometheus(): Promise<void> {
  const helm = findHelm().path;
  fs.mkdirSync(HELM_HOME, { recursive: true });
  const status = await releaseStatus(helm);
  const chart = [
    "prometheus",
    "--repo",
    CHART_REPO,
    "--version",
    CHART_VERSION,
    "-n",
    PROMETHEUS_NAMESPACE,
    "-f",
    VALUES,
    "--wait",
    "--timeout",
    "10m",
    "--kubeconfig",
    KIND_KUBECONFIG,
  ];
  if (status === "deployed") {
    // A release installed before the Mimir fixture: give it the remote write in place.
    if (!(await writesToMimir(helm))) {
      await run(helm, ["upgrade", PROMETHEUS_RELEASE, ...chart], helmEnv());
    }
    return;
  }
  if (status !== null) {
    // A failed or interrupted install: start again from nothing.
    await run(
      helm,
      [
        "uninstall",
        PROMETHEUS_RELEASE,
        "-n",
        PROMETHEUS_NAMESPACE,
        "--kubeconfig",
        KIND_KUBECONFIG,
        "--wait",
      ],
      helmEnv(),
    );
  }
  await run(
    helm,
    ["install", PROMETHEUS_RELEASE, ...chart, "--create-namespace"],
    helmEnv(),
  );
}

/** Applies the Mimir fixture, which is idempotent, and waits for it to be ready. */
async function ensureMimir(): Promise<void> {
  await kubectl(["apply", "-f", MIMIR_MANIFEST]);
  await kubectl([
    "-n",
    MIMIR.namespace,
    "rollout",
    "status",
    "deployment/mimir",
    "--timeout=600s",
  ]);
}

/** The server's Service, with its port named "http", else its first port. */
async function serverService(): Promise<PrometheusService> {
  const out = await kubectl([
    "-n",
    PROMETHEUS_NAMESPACE,
    "get",
    "services",
    "-l",
    PROMETHEUS_SERVER_SELECTOR,
    "-o",
    "json",
  ]);
  const list = JSON.parse(out) as {
    items: {
      metadata: { name: string };
      spec: { ports?: { name?: string; port: number }[] };
    }[];
  };
  const service = list.items[0];
  if (!service) {
    throw new Error(
      `no Service matches ${PROMETHEUS_SERVER_SELECTOR} in ${PROMETHEUS_NAMESPACE}`,
    );
  }
  const ports = service.spec.ports ?? [];
  const port = ports.find((p) => p.name === "http") ?? ports[0];
  if (!port) throw new Error(`${service.metadata.name} has no port`);
  return {
    namespace: PROMETHEUS_NAMESPACE,
    service: service.metadata.name,
    port: port.port,
  };
}

/**
 * Makes sure the kind cluster serves metrics.k8s.io (metrics-server, through
 * `scripts/metrics-up.sh`), runs the Mimir fixture in `skopos-e2e-mimir`, and runs the
 * prometheus-community chart in `skopos-e2e-metrics` writing to Mimir. It skips what is
 * already there and gives the Prometheus server's Service. Needs the network the first
 * time. All of it stays installed for the next run.
 */
export async function ensureMetricsProviders(): Promise<PrometheusService> {
  if (!(await metricsServerServed())) await run("bash", [METRICS_UP]);
  await ensureMimir();
  await ensurePrometheus();
  if (!(await writesToMimir(findHelm().path))) {
    throw new Error(
      `${PROMETHEUS_RELEASE} does not write to ${MIMIR_PUSH_URL}`,
    );
  }
  await kubectl([
    "-n",
    PROMETHEUS_NAMESPACE,
    "wait",
    "--for=condition=Available",
    "deployment",
    "-l",
    PROMETHEUS_SERVER_SELECTOR,
    "--timeout=600s",
  ]);
  return serverService();
}
