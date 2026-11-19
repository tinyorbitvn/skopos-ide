# Changelog

What changed in each SkoposIDE release. Add notes under Unreleased as changes land on main;
`make release VERSION=x.y.z` dates them, and the release workflow publishes them as the
release notes (see `docs/releasing.md`). Releases before 0.6.0 have their notes on the
[releases page](https://github.com/vanlongme/skopos-ide/releases).

## [Unreleased]

- **One + menu in the dock, and several terminals:** the dock's + button opens a menu with Create resource and Terminal Session. Each Terminal Session opens a new local terminal, named Terminal, Terminal 2 and so on, each with its own shell, and they all come back after a restart. Ctrl+` still brings the open terminal forward.
- **Copy any field of the drawer:** every field of an object's drawer, such as a Pod's Node or IP and each container's image, ports and environment, has a copy button that shows while you point at the row. It copies the value as shown, a line per line, without the buttons beside it.
- **Resize table columns:** drag the right edge of a column's header, or focus it and use Left and Right, to make the column wider or narrower; a double-click gives it back its own width. Each kind's list keeps the widths it was given, after a restart too.
- **Usage bars on Nodes:** the Nodes list draws each node's CPU and Memory as a bar of what the node can give (its allocatable), with the share beside it and both amounts on hover. A bar turns orange from 80% and red from 95%.
- **Device Resources:** a new sidebar section lists the Dynamic Resource Allocation kinds a cluster serves: ResourceClaims, ResourceClaimTemplates, DeviceClasses and ResourceSlices. A claim shows its state (Pending, Allocated or Reserved), the Pods that hold it, its requests and the devices it was given; a slice shows its driver, node, pool and each device's attributes and capacity.
- **Every drawer looks the same:** the drawers of Helm releases, Helm charts and port forwards now float over their list like an object's drawer, with the same dimmed screen, resize handle and header: the kind above the name, icon buttons for the actions, then Close. They share the object drawer's width.
- **A faster resource map:** zooming, panning and selecting no longer redraw the whole map, and a new snapshot of the same graph redraws only what changed. With 1,500 resources on the map, a zoom step takes about 10 ms instead of half a second, and dragging a node draws once per frame.
- **Remove a key with an icon:** each key of a Secret or ConfigMap has a trash icon instead of a Remove button, and a removed key shows an undo icon.
- **Control plane health for the Overview (backend):** a new `cluster_control_plane` command reports the API server's version, `/livez` and `/readyz` checks, and the state of etcd, the scheduler, the controller manager, DNS and kube-proxy from their Pods, Leases, Deployments and DaemonSet in `kube-system`. What you may not read is left out instead of failing.
- **Disk use per node (backend):** a new `nodes_disk_usage` command reads each node's root filesystem use from its kubelet through the API server's node proxy, up to eight nodes at a time; a node that does not answer is left out.

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
