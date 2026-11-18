# Changelog

What changed in each SkoposIDE release. Add notes under Unreleased as changes land on main;
`make release VERSION=x.y.z` dates them, and the release workflow publishes them as the
release notes (see `docs/releasing.md`). Releases before 0.6.0 have their notes on the
[releases page](https://github.com/vanlongme/skopos-ide/releases).

## [Unreleased]

- **One main view with tabs, splits and windows:** the Workspace page is gone. Every screen opens in a tab; tabs can be pinned, split side by side into up to three panes, and dragged into their own windows, and they come back after a restart. The sidebar follows the focused tab, and the Catalog can be sorted into nested folders.
- **Lists keep their order as objects come and go:** a new or re-created object, such as a Pod that replaces a deleted one, shows in its place by namespace and name instead of at the bottom, and its Age counts up every second during its first minute.

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
