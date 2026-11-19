# Changelog

What changed in each SkoposIDE release. Add notes under Unreleased as changes land on main;
`make release VERSION=x.y.z` dates them, and the release workflow publishes them as the
release notes (see `docs/releasing.md`). Releases before 0.6.0 have their notes on the
[releases page](https://github.com/vanlongme/skopos-ide/releases).

## [Unreleased]

- **Control plane health for the Overview (backend):** a new `cluster_control_plane` command reports the API server's version, `/livez` and `/readyz` checks, and the state of etcd, the scheduler, the controller manager, DNS and kube-proxy from their Pods, Leases, Deployments and DaemonSet in `kube-system`. What you may not read is left out instead of failing.
- **Disk use per node (backend):** a new `nodes_disk_usage` command reads each node's root filesystem use from its kubelet through the API server's node proxy, up to eight nodes at a time; a node that does not answer is left out.
- **Lighter watched rows (backend):** the rows of Nodes, ConfigMaps, ReplicaSets and CustomResourceDefinitions keep only what the lists, actions and graph read: Nodes drop their image list and most `nodeInfo`, ConfigMaps keep their keys with empty values, ReplicaSets keep the selector, container names and replica counts, and CRDs drop their schemas and conversion webhook. The detail drawer fetches the whole object.
- **Watch one object (backend):** a new `resources_subscribe_object` command streams a single object, by name, as a snapshot of one row and then its changes, with the same events and statuses as a table's watch. It sends the whole object, so a drawer no longer needs a table's watcher or a refetch.
- **Helm releases subscription (backend):** new `helm_releases_subscribe` and `helm_releases_unsubscribe` commands watch the Secrets Helm labels `owner=helm` (metadata only, no payload) and send one `changed` per burst of changes, so the releases screen can list again without polling. `forbidden` or `failed` end the subscription once; the screen then polls every 60 s. Releases kept in ConfigMaps or SQL are not seen. A cluster that refuses the cluster-wide `helm list` is also remembered for 60 s, so each refresh skips the call that cannot succeed.
- **One Pod watch for the table and the Map (backend):** with a Pods table and the Map open, the core now watches Pods once instead of twice; each view still gets its own, differently trimmed rows.
- **No idle wake-ups in watches (backend):** a watch subscriber's flush timer no longer ticks every 150 ms while nothing changes; it sleeps until a change, a status or a snapshot is queued. A change still reaches the interface within the same 150 ms batch.

## [0.8.0] - 2026-11-18

- **One main view with tabs, splits and windows:** the Workspace page is gone. Every screen opens in a tab; tabs can be pinned, split side by side into up to three panes, and dragged into their own windows, and they come back after a restart. The sidebar follows the focused tab, and the Catalog can be sorted into nested folders.
- **Secrets edited in place:** a revealed value is an editable field, as raw text or as base64, so binary values can be edited too; the Edit button is gone.
- **Animated icons:** the app's icons are now Lucide's, animated when you hover or focus their button or menu item, and still with Reduce Motion; Edit YAML shows a pen, and Delete sits in the object toolbar instead of the ⋯ menu.
- **Lists keep their order as objects come and go:** a new or re-created object, such as a Pod that replaces a deleted one, shows in its place by namespace and name instead of at the bottom, and its Age counts up every second during its first minute.
- **Project site:** the landing page is now dark: a ribbon in the app's orbit blues, drawn with WebGL, moves behind the headline and the closing call to action, and the features sit in a grid of cards. With reduced motion the ribbon stands still, and without WebGL a glow takes its place.

## [0.7.0] - 2026-11-18

- **Minimize the details drawer into the dock:** a new Minimize button in the drawer's header moves the object into a dock tab below its list, which stays in full view. The tab shows the drawer's tabs live, follows links with Back and comes back after a restart; **Open as drawer** puts the object back over its own list, on the same tab.
- **API docs beside the YAML editor:** edit and create tabs show the fields of the object's kind from the cluster's own API docs, with search, a field tree and each field's type, default and description; the **API docs** button hides them in every tab.

- **Sidebar order:** Helm and Argo CD sit right under Nodes, before Workloads.
- **Gateway API under Network:** every Gateway API kind, standard and experimental, is listed under Network instead of Custom Resources. ListenerSets, BackendTLSPolicies and the GRPC, TLS, TCP and UDP routes get their own columns.
- **Property filter:** the list's filter box builds filters on name, namespace, label or annotation from suggestions taken from the list. Filters show as tokens joined by and or or, and each row shows the labels and annotations it matched by. Pods keep their annotations in the list, so they are found by annotation too.
- **Workload Status from Pods:** the Status of Deployments, StatefulSets, ReplicaSets, DaemonSets, Jobs and CronJobs shows the most serious state among their Pods, such as CrashLoopBackOff, with how many Pods are in it and `+N` for other problems. Hovering it or focusing it opens a card that lists the Pods by state, with restarts and messages such as why a Pod was evicted.
- **Node conditions in the Status:** the Node list shows Ready, NotReady or Unknown, then conditions that are happening, such as memory or disk pressure, and SchedulingDisabled. A card lists every condition with its age and reason.
- **Access on the resource map:** the map follows a workload's ServiceAccount to the RoleBindings and ClusterRoleBindings that bind it and the Roles and ClusterRoles they grant, with each role's rules in the details pane.
- **Export the resource map:** the cluster and object maps save what they show as a PNG image or a PDF document.
- **SkoposIDE's own action icons:** the icons of actions such as Delete, Edit YAML, Logs, Shell, Scale, Restart and Drain are drawn for SkoposIDE in one flat style, and each action shows the same icon in every toolbar, menu and button.
- **Metrics from a Prometheus-compatible URL:** Cluster settings gain a "Prometheus-compatible URL" option that reads metrics straight from Grafana Mimir, Grafana Cloud or another Prometheus API, with a tenant, a cluster label and no authentication, Basic, a Bearer token or a client certificate, plus an optional CA file. Passwords and tokens are kept only in the system keychain. The source line names the URL's host.
- **Project site:** a landing page at https://vanlongme.github.io/skopos-ide/ with what the app does, the latest release's installers for each platform and the roadmap. It is built from `site/` by `scripts/build-site.mjs` and deployed by the new `pages` workflow after every change to it and after every release.
- **License notices:** `THIRD_PARTY_NOTICES.md` now lists the license of every npm package bundled in the interface and of the 543 Rust crates linked into the app, with the copyright notices and license texts those licenses ask for.

## [0.6.1] - 2026-11-16

- **Metrics errors show:** when Prometheus, Mimir or metrics-server times out or answers 502, 503 or 504 while the cluster is connected, the Metrics tab and the Overview show the error with Retry instead of loading forever.

## [0.6.0] - 2026-11-16

- **New app icon and logo:** the TinyOrbit orbit mark, white on navy, replaces the old icon on Linux, macOS and Windows and in the About dialog.
- **Metrics from Grafana Mimir and other multi-tenant Prometheus APIs:** the "Prometheus or Mimir in the cluster" setting in Cluster settings gains:
  - **Scheme** (http or https) and **Path prefix**, such as `/prometheus` for Mimir;
  - **Tenant**, sent as the `X-Scope-OrgID` header; when Mimir answers "no org id", the app says that a tenant is needed;
  - **Cluster label**, a name and value added to every metrics query, for a Mimir or Prometheus that holds several clusters.
- **Metrics source line:** names the tenant and the cluster label in use. When a query answers with no samples, it says which setting to check; a query that fails is reported apart from one that comes back empty.
- **Details drawer:** in the Overview, Metadata comes right under Summary.
