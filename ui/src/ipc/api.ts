import { Channel } from "@tauri-apps/api/core";
import { call } from "./client";
import type { ApiResourceInfo } from "./generated/ApiResourceInfo";
import type { AppInfo } from "./generated/AppInfo";
import type { ApplyResult } from "./generated/ApplyResult";
import type { ArgoRollbackOptions } from "./generated/ArgoRollbackOptions";
import type { ArgoSyncOptions } from "./generated/ArgoSyncOptions";
import type { CatalogFolder } from "./generated/CatalogFolder";
import type { CatalogFolders } from "./generated/CatalogFolders";
import type { ChartSearch } from "./generated/ChartSearch";
import type { ChartVersion } from "./generated/ChartVersion";
import type { ClusterEntry } from "./generated/ClusterEntry";
import type { ClusterSettings } from "./generated/ClusterSettings";
import type { ConnectionLogEntry } from "./generated/ConnectionLogEntry";
import type { ConnectionState } from "./generated/ConnectionState";
import type { ControlPlane } from "./generated/ControlPlane";
import type { DataChange } from "./generated/DataChange";
import type { DrainEvent } from "./generated/DrainEvent";
import type { DrainOptions } from "./generated/DrainOptions";
import type { GraphEvent } from "./generated/GraphEvent";
import type { HelmInfo } from "./generated/HelmInfo";
import type { HelmInstallRequest } from "./generated/HelmInstallRequest";
import type { HelmPreview } from "./generated/HelmPreview";
import type { HelmReleaseDetail } from "./generated/HelmReleaseDetail";
import type { HelmReleaseList } from "./generated/HelmReleaseList";
import type { HelmReleasesEvent } from "./generated/HelmReleasesEvent";
import type { HelmRepo } from "./generated/HelmRepo";
import type { HelmRepoAdd } from "./generated/HelmRepoAdd";
import type { HelmRevision } from "./generated/HelmRevision";
import type { HelmUpgradeRequest } from "./generated/HelmUpgradeRequest";
import type { InvolvedRef } from "./generated/InvolvedRef";
import type { KindSchema } from "./generated/KindSchema";
import type { LogDownload } from "./generated/LogDownload";
import type { LogEvent } from "./generated/LogEvent";
import type { LogOptions } from "./generated/LogOptions";
import type { LogTarget } from "./generated/LogTarget";
import type { MapFormat } from "./generated/MapFormat";
import type { MetricsProvider } from "./generated/MetricsProvider";
import type { MetricsProviderSetting } from "./generated/MetricsProviderSetting";
import type { MetricsRange } from "./generated/MetricsRange";
import type { MetricsResult } from "./generated/MetricsResult";
import type { MetricsTarget } from "./generated/MetricsTarget";
import type { MoveOutcome } from "./generated/MoveOutcome";
import type { MoveTarget } from "./generated/MoveTarget";
import type { NodeDiskSnapshot } from "./generated/NodeDiskSnapshot";
import type { ObjectNames } from "./generated/ObjectNames";
import type { PortForward } from "./generated/PortForward";
import type { PortForwardSpec } from "./generated/PortForwardSpec";
import type { Prefs } from "./generated/Prefs";
import type { Propagation } from "./generated/Propagation";
import type { ResourceRef } from "./generated/ResourceRef";
import type { SavedKubeconfig } from "./generated/SavedKubeconfig";
import type { SecretChange } from "./generated/SecretChange";
import type { SecretValue } from "./generated/SecretValue";
import type { SessionEvent } from "./generated/SessionEvent";
import type { SyncWarning } from "./generated/SyncWarning";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { TerminalSize } from "./generated/TerminalSize";
import type { ToolName } from "./generated/ToolName";
import type { ToolStatus } from "./generated/ToolStatus";
import type { TopologyEvent } from "./generated/TopologyEvent";
import type { UpdateState } from "./generated/UpdateState";
import type { UsageOf } from "./generated/UsageOf";
import type { UsageSnapshot } from "./generated/UsageSnapshot";
import type { WatchEvent } from "./generated/WatchEvent";
import type { WindowLayout } from "./generated/WindowLayout";

export const api = {
  /** Version facts for About (spec C §8.2). */
  appInfo: () => call<AppInfo>("app_info"),
  catalogList: () => call<ClusterEntry[]>("catalog_list"),
  catalogWarnings: () => call<SyncWarning[]>("catalog_warnings"),
  catalogAddPasted: (yaml: string) =>
    call<string[]>("catalog_add_pasted", { yaml }),
  catalogRemovePasted: (id: string) =>
    call<void>("catalog_remove_pasted", { id }),
  /** The folder tree of the Catalog and the cluster placements (spec P26). */
  catalogFolders: () => call<CatalogFolders>("catalog_folders"),
  /** `parent` null: at the top level. Name errors reject with InvalidInput (P27). */
  catalogFolderCreate: (parent: string | null, name: string) =>
    call<CatalogFolder>("catalog_folder_create", { parent, name }),
  catalogFolderRename: (id: string, name: string) =>
    call<void>("catalog_folder_rename", { id, name }),
  /** `parent` null: to the top level. */
  catalogFolderMove: (id: string, parent: string | null) =>
    call<void>("catalog_folder_move", { id, parent }),
  /** Its clusters and subfolders move to its parent (P28). */
  catalogFolderDelete: (id: string) =>
    call<void>("catalog_folder_delete", { id }),
  /** `folder` null: to the top level. */
  catalogClusterPlace: (cluster: string, folder: string | null) =>
    call<void>("catalog_cluster_place", { cluster, folder }),
  clusterConnect: (id: string) =>
    call<ConnectionState>("cluster_connect", { id }),
  clusterDisconnect: (id: string) => call<void>("cluster_disconnect", { id }),
  clusterState: (id: string) => call<ConnectionState>("cluster_state", { id }),
  /** Health of the API server and the control-plane components; what is not visible is null. */
  clusterControlPlane: (id: string) =>
    call<ControlPlane>("cluster_control_plane", { id }),
  clusterLog: (id: string) => call<ConnectionLogEntry[]>("cluster_log", { id }),
  clusterSettingsGet: (id: string) =>
    call<ClusterSettings>("cluster_settings_get", { id }),
  clusterSettingsSet: (id: string, settings: ClusterSettings) =>
    call<void>("cluster_settings_set", { id, settings }),
  hotbarGet: () => call<string[]>("hotbar_get"),
  hotbarSet: (ids: string[]) => call<void>("hotbar_set", { ids }),
  prefsGet: () => call<Prefs>("prefs_get"),
  prefsSet: (prefs: Prefs) => call<void>("prefs_set", { prefs }),
  resourcesDiscover: (clusterId: string, refresh: boolean) =>
    call<ApiResourceInfo[]>("resources_discover", { clusterId, refresh }),
  /** The names of 14 kinds for the palette; the backend keeps them for 30 s. */
  resourcesNames: (clusterId: string) =>
    call<ObjectNames>("resources_names", { clusterId }),
  /**
   * Returns the subscription id. Events go to `onEvent` until unsubscribed. With
   * `namespaces`, only the objects of those namespaces are sent; with none, all are.
   */
  resourcesSubscribe: (
    clusterId: string,
    resource: ResourceRef,
    namespaces: string[],
    onEvent: (event: WatchEvent) => void,
  ) =>
    call<string>("resources_subscribe", {
      clusterId,
      resource,
      namespaces,
      onEvent: new Channel<WatchEvent>(onEvent),
    }),
  resourcesUnsubscribe: (subscriptionId: string) =>
    call<void>("resources_unsubscribe", { subscriptionId }),
  /**
   * Returns the subscription id of a watch of one whole object: a snapshot of 0 or 1 rows,
   * then batches, and `status` events as a table's watch sends them. `namespace` is null
   * for a cluster-scoped resource. End it with `resourcesUnsubscribe`.
   */
  resourcesSubscribeObject: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
    onEvent: (event: WatchEvent) => void,
  ) =>
    call<string>("resources_subscribe_object", {
      clusterId,
      resource,
      namespace,
      name,
      onEvent: new Channel<WatchEvent>(onEvent),
    }),
  /**
   * Returns the subscription id of a watch of the Pods bound to the node `node`: the rows
   * a list of Pods has, sent as a list's are. The API server picks the Pods, so those of
   * the other nodes are never read. End it with `resourcesUnsubscribe`.
   */
  resourcesSubscribeNodePods: (
    clusterId: string,
    node: string,
    onEvent: (event: WatchEvent) => void,
  ) =>
    call<string>("resources_subscribe_node_pods", {
      clusterId,
      node,
      onEvent: new Channel<WatchEvent>(onEvent),
    }),
  /**
   * Returns the subscription id. Graph snapshots of `namespaces` (null: every
   * namespace) go to `onEvent` until unsubscribed or until a `failure` ends it.
   */
  resourceGraphSubscribe: (
    clusterId: string,
    namespaces: string[] | null,
    onEvent: (event: GraphEvent) => void,
  ) =>
    call<string>("resource_graph_subscribe", {
      clusterId,
      namespaces,
      onEvent: new Channel<GraphEvent>(onEvent),
    }),
  resourceGraphUnsubscribe: (subscriptionId: string) =>
    call<void>("resource_graph_unsubscribe", { subscriptionId }),
  /**
   * Returns the subscription id. Node topology snapshots go to `onEvent` until
   * unsubscribed or until a `failure` ends it (topology spec §4.2).
   */
  nodeTopologySubscribe: (
    clusterId: string,
    onEvent: (event: TopologyEvent) => void,
  ) =>
    call<string>("node_topology_subscribe", {
      clusterId,
      onEvent: new Channel<TopologyEvent>(onEvent),
    }),
  nodeTopologyUnsubscribe: (subscriptionId: string) =>
    call<void>("node_topology_unsubscribe", { subscriptionId }),
  /**
   * Saves the map as drawn: the backend opens the save dialog with the suggested
   * name and returns the path written, or null when the user cancels (spec O §6.4).
   * `png` is base64 without a `data:` prefix.
   */
  mapExport: (
    suggestedName: string,
    format: MapFormat,
    png: string,
    scale: number,
  ) => call<string | null>("map_export", { suggestedName, format, png, scale }),
  resourceGet: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
  ) =>
    call<JsonValue>("resource_get", { clusterId, resource, namespace, name }),
  resourceGetYaml: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
  ) =>
    call<string>("resource_get_yaml", {
      clusterId,
      resource,
      namespace,
      name,
    }),
  resourceReplace: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
    yaml: string,
    force: boolean,
  ) =>
    call<JsonValue>("resource_replace", {
      clusterId,
      resource,
      namespace,
      name,
      yaml,
      force,
    }),
  resourceApply: (clusterId: string, yaml: string, defaultNamespace: string) =>
    call<ApplyResult[]>("resource_apply", {
      clusterId,
      yaml,
      defaultNamespace,
    }),
  resourceDelete: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
    propagation: Propagation,
  ) =>
    call<void>("resource_delete", {
      clusterId,
      resource,
      namespace,
      name,
      propagation,
    }),
  argocdSync: (
    clusterId: string,
    namespace: string,
    name: string,
    options: ArgoSyncOptions,
  ) => call<void>("argocd_sync", { clusterId, namespace, name, options }),
  argocdRefresh: (
    clusterId: string,
    namespace: string,
    name: string,
    hard: boolean,
  ) => call<void>("argocd_refresh", { clusterId, namespace, name, hard }),
  argocdTerminate: (clusterId: string, namespace: string, name: string) =>
    call<void>("argocd_terminate", { clusterId, namespace, name }),
  argocdRollback: (
    clusterId: string,
    namespace: string,
    name: string,
    options: ArgoRollbackOptions,
  ) => call<void>("argocd_rollback", { clusterId, namespace, name, options }),
  argocdDelete: (
    clusterId: string,
    namespace: string,
    name: string,
    cascade: boolean,
  ) => call<void>("argocd_delete", { clusterId, namespace, name, cascade }),
  resourceForceFinalize: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
  ) =>
    call<void>("resource_force_finalize", {
      clusterId,
      resource,
      namespace,
      name,
    }),
  resourceEvents: (clusterId: string, involved: InvolvedRef) =>
    call<JsonValue[]>("resource_events", { clusterId, involved }),
  apiSchema: (clusterId: string, apiVersion: string, kind: string) =>
    call<KindSchema>("api_schema", { clusterId, apiVersion, kind }),
  workloadScale: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string,
    name: string,
    replicas: number,
  ) =>
    call<void>("workload_scale", {
      clusterId,
      resource,
      namespace,
      name,
      replicas,
    }),
  /** Asks for `storage` (a quantity, as "20Gi") on the claim; the server expands the volume. */
  pvcResize: (
    clusterId: string,
    namespace: string,
    name: string,
    storage: string,
  ) => call<void>("pvc_resize", { clusterId, namespace, name, storage }),
  workloadRestart: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string,
    name: string,
  ) => call<void>("workload_restart", { clusterId, resource, namespace, name }),
  podEvict: (clusterId: string, namespace: string, name: string) =>
    call<void>("pod_evict", { clusterId, namespace, name }),
  cronjobTrigger: (clusterId: string, namespace: string, name: string) =>
    call<string>("cronjob_trigger", { clusterId, namespace, name }),
  cronjobSetSuspend: (
    clusterId: string,
    namespace: string,
    name: string,
    suspend: boolean,
  ) =>
    call<void>("cronjob_set_suspend", { clusterId, namespace, name, suspend }),
  podForceDelete: (
    clusterId: string,
    namespace: string,
    name: string,
    uid: string,
  ) => call<void>("pod_force_delete", { clusterId, namespace, name, uid }),
  jobSetSuspend: (
    clusterId: string,
    namespace: string,
    name: string,
    suspend: boolean,
  ) => call<void>("job_set_suspend", { clusterId, namespace, name, suspend }),
  ingressClassSetDefault: (clusterId: string, name: string) =>
    call<void>("ingress_class_set_default", { clusterId, name }),
  serviceAccountKubeconfigSave: (
    clusterId: string,
    namespace: string,
    name: string,
    suggestedName: string,
    expirationSeconds: number,
  ) =>
    call<SavedKubeconfig | null>("service_account_kubeconfig_save", {
      clusterId,
      namespace,
      name,
      suggestedName,
      expirationSeconds,
    }),
  nodeSetUnschedulable: (
    clusterId: string,
    name: string,
    unschedulable: boolean,
  ) => call<void>("node_set_unschedulable", { clusterId, name, unschedulable }),
  /** Returns the drain id. Events go to `onEvent`, the last being `finished`. */
  nodeDrainStart: (
    clusterId: string,
    name: string,
    options: DrainOptions,
    onEvent: (event: DrainEvent) => void,
  ) =>
    call<string>("node_drain_start", {
      clusterId,
      name,
      options,
      onEvent: new Channel<DrainEvent>(onEvent),
    }),
  nodeDrainCancel: (drainId: string) =>
    call<void>("node_drain_cancel", { drainId }),
  secretReveal: (
    clusterId: string,
    namespace: string,
    name: string,
    key: string,
  ) => call<SecretValue>("secret_reveal", { clusterId, namespace, name, key }),
  secretUpdate: (
    clusterId: string,
    namespace: string,
    name: string,
    resourceVersion: string,
    changes: SecretChange[],
  ) =>
    call<void>("secret_update", {
      clusterId,
      namespace,
      name,
      resourceVersion,
      changes,
    }),
  configmapUpdate: (
    clusterId: string,
    namespace: string,
    name: string,
    resourceVersion: string,
    changes: DataChange[],
  ) =>
    call<void>("configmap_update", {
      clusterId,
      namespace,
      name,
      resourceVersion,
      changes,
    }),
  /** Returns the session id. Events go to `onEvent` until the session ends or is stopped. */
  logsStart: (
    clusterId: string,
    target: LogTarget,
    options: LogOptions,
    onEvent: (event: LogEvent) => void,
  ) =>
    call<string>("logs_start", {
      clusterId,
      target,
      options,
      onEvent: new Channel<LogEvent>(onEvent),
    }),
  logsStop: (sessionId: string) => call<void>("logs_stop", { sessionId }),
  logsDownload: (
    clusterId: string,
    target: LogTarget,
    options: LogOptions,
    suggestedName: string,
  ) =>
    call<LogDownload | null>("logs_download", {
      clusterId,
      target,
      options,
      suggestedName,
    }),
  /** Tells the backend that `bytes` of a session's output are stored. */
  sessionAck: (sessionId: string, bytes: number) =>
    call<void>("session_ack", { sessionId, bytes }),
  /** Starts the local shell. Output goes to `onData`, everything else to `onEvent`. */
  terminalStart: (
    clusterId: string,
    size: TerminalSize,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("terminal_start", {
      clusterId,
      size,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  /** A shell in a Pod's container; null lets the backend pick the container. */
  podExecStart: (
    clusterId: string,
    namespace: string,
    pod: string,
    container: string | null,
    size: TerminalSize,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("pod_exec_start", {
      clusterId,
      namespace,
      pod,
      container,
      size,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  /** Attaches to a container's PID 1. */
  podAttachStart: (
    clusterId: string,
    namespace: string,
    pod: string,
    container: string | null,
    size: TerminalSize,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("pod_attach_start", {
      clusterId,
      namespace,
      pod,
      container,
      size,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  /** A root shell on a node, through a privileged Pod the backend deletes when the session stops. */
  nodeShellStart: (
    clusterId: string,
    node: string,
    size: TerminalSize,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("node_shell_start", {
      clusterId,
      node,
      size,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  /** Input for the process, as UTF-8 bytes. */
  sessionWrite: (sessionId: string, data: number[]) =>
    call<void>("session_write", { sessionId, data }),
  sessionResize: (sessionId: string, size: TerminalSize) =>
    call<void>("session_resize", { sessionId, size }),
  sessionStop: (sessionId: string) => call<void>("session_stop", { sessionId }),
  portforwardList: () => call<PortForward[]>("portforward_list"),
  /** Saves the definition; it does not start it. */
  portforwardAdd: (spec: PortForwardSpec) =>
    call<PortForward>("portforward_add", { spec }),
  /** Answers once the listener is bound. */
  portforwardStart: (id: string) =>
    call<PortForward>("portforward_start", { id }),
  /** Safe to repeat. */
  portforwardStop: (id: string) => call<void>("portforward_stop", { id }),
  /** Stops the forward first. */
  portforwardRemove: (id: string) => call<void>("portforward_remove", { id }),
  /** The backend opens https URLs, and http ones on localhost or 127.0.0.1. */
  openExternal: (url: string) => call<void>("open_external", { url }),
  /** Never touches the network. */
  toolsStatus: () => call<ToolStatus[]>("tools_status"),
  /** Resolves once installed; progress comes as `tools://progress` events. */
  toolsDownload: (tool: ToolName) =>
    call<ToolStatus>("tools_download", { tool }),
  toolsDownloadCancel: (tool: ToolName) =>
    call<void>("tools_download_cancel", { tool }),
  helmVersion: () => call<HelmInfo>("helm_version"),
  helmRepoList: () => call<HelmRepo[]>("helm_repo_list"),
  helmRepoAdd: (repo: HelmRepoAdd) => call<void>("helm_repo_add", { repo }),
  helmRepoRemove: (name: string) => call<void>("helm_repo_remove", { name }),
  /** Null updates every repository. */
  helmRepoUpdate: (names: string[] | null) =>
    call<void>("helm_repo_update", { names }),
  /** An empty query lists every chart; a null limit lists them all. */
  helmChartSearch: (query: string, limit: number | null) =>
    call<ChartSearch>("helm_chart_search", { query, limit }),
  /** Newest first. */
  helmChartVersions: (repo: string, chart: string) =>
    call<ChartVersion[]>("helm_chart_versions", { repo, chart }),
  /** Untrusted markdown from the chart's author. */
  helmChartReadme: (repo: string, chart: string, version: string) =>
    call<string>("helm_chart_readme", { repo, chart, version }),
  /** YAML. */
  helmChartValues: (repo: string, chart: string, version: string) =>
    call<string>("helm_chart_values", { repo, chart, version }),
  /** Null lists every namespace. */
  helmReleaseList: (clusterId: string, namespaces: string[] | null) =>
    call<HelmReleaseList>("helm_release_list", { clusterId, namespaces }),
  helmReleaseGet: (clusterId: string, namespace: string, name: string) =>
    call<HelmReleaseDetail>("helm_release_get", {
      clusterId,
      namespace,
      name,
    }),
  /** YAML: the computed values when `all`, else the user-supplied ones ("" for none). */
  helmReleaseValues: (
    clusterId: string,
    namespace: string,
    name: string,
    all: boolean,
  ) => call<string>("helm_release_values", { clusterId, namespace, name, all }),
  /** Newest first. */
  helmReleaseHistory: (clusterId: string, namespace: string, name: string) =>
    call<HelmRevision[]>("helm_release_history", {
      clusterId,
      namespace,
      name,
    }),
  /**
   * Returns the subscription id. `onEvent` gets `changed` when a release changes (the
   * list again once), or one `forbidden` or `failed` that ends the subscription. Nothing
   * is sent at start. After `forbidden`, poll instead.
   */
  helmReleasesSubscribe: (
    clusterId: string,
    onEvent: (event: HelmReleasesEvent) => void,
  ) =>
    call<string>("helm_releases_subscribe", {
      clusterId,
      onEvent: new Channel<HelmReleasesEvent>(onEvent),
    }),
  helmReleasesUnsubscribe: (subscriptionId: string) =>
    call<void>("helm_releases_unsubscribe", { subscriptionId }),
  /** A server-side dry run; it creates nothing. */
  helmInstallPreview: (clusterId: string, request: HelmInstallRequest) =>
    call<HelmPreview>("helm_install_preview", { clusterId, request }),
  helmUpgradePreview: (clusterId: string, request: HelmUpgradeRequest) =>
    call<HelmPreview>("helm_upgrade_preview", { clusterId, request }),
  /** Returns the session id. helm's output goes to `onData`, the rest to `onEvent`. */
  helmInstallStart: (
    clusterId: string,
    request: HelmInstallRequest,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("helm_install_start", {
      clusterId,
      request,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  helmUpgradeStart: (
    clusterId: string,
    request: HelmUpgradeRequest,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("helm_upgrade_start", {
      clusterId,
      request,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  helmRollbackStart: (
    clusterId: string,
    namespace: string,
    release: string,
    revision: number,
    wait: boolean,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("helm_rollback_start", {
      clusterId,
      namespace,
      release,
      revision,
      wait,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  /** `keepHistory` passes --keep-history: the release stays listed as `uninstalled`. */
  helmUninstallStart: (
    clusterId: string,
    namespace: string,
    release: string,
    wait: boolean,
    keepHistory: boolean,
    onData: (chunk: ArrayBuffer) => void,
    onEvent: (event: SessionEvent) => void,
  ) =>
    call<string>("helm_uninstall_start", {
      clusterId,
      namespace,
      release,
      wait,
      keepHistory,
      onData: new Channel<ArrayBuffer>(onData),
      onEvent: new Channel<SessionEvent>(onEvent),
    }),
  /** Where this cluster's metrics come from. `refresh` looks again instead of using the cache. */
  metricsProvider: (clusterId: string, refresh: boolean) =>
    call<MetricsProvider>("metrics_provider", { clusterId, refresh }),
  /** Prometheus only: rejects with NotFound "noPrometheus" under another provider. */
  metricsQuery: (
    clusterId: string,
    target: MetricsTarget,
    range: MetricsRange,
  ) => call<MetricsResult>("metrics_query", { clusterId, target, range }),
  /** metrics.k8s.io; null lists every namespace. NotFound "noMetricsServer" when not served. */
  metricsUsage: (clusterId: string, of: UsageOf, namespace: string | null) =>
    call<UsageSnapshot>("metrics_usage", { clusterId, of, namespace }),
  /**
   * Root filesystem use of the named nodes, from each kubelet through the node proxy. A node
   * that cannot be read is left out; Forbidden when every node answered 403.
   */
  nodesDiskUsage: (id: string, names: string[]) =>
    call<NodeDiskSnapshot>("nodes_disk_usage", { id, names }),
  /**
   * Saves the metrics URL's password or token in the keychain, replacing the saved one. The
   * core validates `provider`, the setting about to be saved, first and refuses the secret
   * when it refuses the setting.
   */
  metricsSecretSet: (
    clusterId: string,
    secret: string,
    provider: MetricsProviderSetting,
  ) => call<void>("metrics_secret_set", { clusterId, secret, provider }),
  /** Whether the keychain holds a password or token for the cluster's metrics URL. */
  metricsSecretSaved: (clusterId: string) =>
    call<boolean>("metrics_secret_saved", { clusterId }),
  /** This window's layout; the backend knows which window asks (P32). */
  windowLayoutGet: () => call<WindowLayout>("window_layout_get"),
  /** Saves this window's layout. Its `label` must be this window's. */
  windowLayoutSet: (layout: WindowLayout) =>
    call<void>("window_layout_set", { layout }),
  /** The layouts of every open window, `main` first. */
  windowsList: () => call<WindowLayout[]>("windows_list"),
  /** This window has sent its last layout before the app quits (P34). */
  windowFlushed: () => call<void>("window_flushed"),
  /**
   * Moves a tab of this window to another window or into a new one (P31, P33).
   * Rejects with NotFound "That window is closed." when the target has gone.
   */
  windowTabMove: (tabId: string, target: MoveTarget) =>
    call<MoveOutcome>("window_tab_move", { tabId, target }),
  /**
   * A tab let go outside this window at `screenX`, `screenY` (logical pixels, as the
   * pointer event gives them): it moves to the window under that point, or to a new one.
   */
  windowTabDrop: (tabId: string, screenX: number, screenY: number) =>
    call<MoveOutcome>("window_tab_drop", { tabId, screenX, screenY }),
  uiStateGet: (key: string) => call<JsonValue | null>("ui_state_get", { key }),
  uiStateSet: (key: string, value: JsonValue) =>
    call<void>("ui_state_set", { key, value }),
  /** The in-app update state now; later changes arrive as `update://state`. */
  updateStateGet: () => call<UpdateState>("update_state_get"),
  /** A check the user asked for. Answers with the state it ended in, a failure included. */
  updateCheck: () => call<UpdateState>("update_check"),
  /**
   * Downloads, verifies and installs the available release. The app restarts when it
   * succeeds; a failure also arrives as the `failed` state.
   */
  updateInstall: () => call<void>("update_install"),
  /** Stops a download; the state goes back to `available`. */
  updateCancel: () => call<void>("update_cancel"),
  /** No toast or status bar button for this version; a manual check still shows it. */
  updateSkip: (version: string) => call<void>("update_skip", { version }),
};
