# Changelog

What changed in each SkoposIDE release. Add notes under Unreleased as changes land on main;
`make release VERSION=x.y.z` dates them, and the release workflow publishes them as the
release notes (see `docs/releasing.md`). Releases before 0.6.0 have their notes on the
[releases page](https://github.com/vanlongme/skopos-ide/releases).

## [Unreleased]

- **One + menu in the dock, and several terminals:** the dock's + button opens a menu with Create resource and Terminal Session. Each Terminal Session opens a new local terminal, named Terminal, Terminal 2 and so on, each with its own shell, and they all come back after a restart. Ctrl+` still brings the open terminal forward.
- **Copy any field of the drawer:** every field of an object's drawer, such as a Pod's Node or IP and each container's image, ports and environment, has a copy button that shows while you point at the row. It copies the value as shown, a line per line, without the buttons beside it.
- **Resize table columns:** drag the right edge of a column's header, or focus it and use Left and Right, to make the column wider or narrower; a double-click gives it back its own width. Each kind's list keeps the widths it was given, after a restart too.
- **Usage bars on Nodes:** the Nodes list draws each node's CPU and Memory as a bar of what the node can give (its allocatable), with the share beside it and both amounts on hover. A Disk bar shows the node's root filesystem, read from its kubelet through the API server every 30 seconds; without access to `nodes/proxy` the column says so on hover. A bar turns orange from 80% and red from 95%.
- **Device Resources:** a new sidebar section lists the Dynamic Resource Allocation kinds a cluster serves: ResourceClaims, ResourceClaimTemplates, DeviceClasses and ResourceSlices. A claim shows its state (Pending, Allocated or Reserved), the Pods that hold it, its requests and the devices it was given; a slice shows its driver, node, pool and each device's attributes and capacity.
- **Every drawer looks the same:** the drawers of Helm releases, Helm charts and port forwards now float over their list like an object's drawer, with the same dimmed screen, resize handle and header: the kind above the name, icon buttons for the actions, then Close. They share the object drawer's width.
- **Lighter on large clusters:** going back to a list within 20 seconds shows it at once instead of loading it again, and a minimized window or a hidden Logs tab stops drawing until it is shown. A table redraws only the rows that changed and counts its filter suggestions only while the filter box has focus. The usage history behind the Metrics charts is kept only while a Metrics panel is open, and no longer grows by tens of megabytes an hour. Helm Releases asks Helm every 60 seconds instead of 15, and again when you come back to the window after that long. The command palette prepares each name once and waits 100 ms between keys on very large clusters, terminal output is acknowledged in batches, the Force map layout continues from the last positions instead of starting over, and every view of a cluster shares one API discovery.
- **A faster resource map:** zooming, panning and selecting no longer redraw the whole map, and a new snapshot of the same graph redraws only what changed. With 1,500 resources on the map, a zoom step takes about 10 ms instead of half a second, and dragging a node draws once per frame.
- **Remove a key with an icon:** each key of a Secret or ConfigMap has a trash icon instead of a Remove button, and a removed key shows an undo icon.
- **Control plane on the Overview:** a cluster's Overview starts with its control plane: the API server's version, address and `/livez` and `/readyz` checks (each failing check named), then etcd, the scheduler, the controller manager, DNS and kube-proxy, each healthy, degraded or unhealthy with what that rests on, such as ready Pods, the leader's last renewal or the readyz check. A part the provider runs, or that you may not read, shows as not visible instead of failing. The section reads again every 30 seconds.
- **Lighter watched rows (backend):** the rows of Nodes, ConfigMaps, ReplicaSets and CustomResourceDefinitions keep only what the lists, actions and graph read: Nodes drop their image list and most `nodeInfo`, ConfigMaps keep their keys with empty values, ReplicaSets keep the selector, container names and replica counts, and CRDs drop their schemas and conversion webhook. The detail drawer fetches the whole object.
- **Watch one object (backend):** a new `resources_subscribe_object` command streams a single object, by name, as a snapshot of one row and then its changes, with the same events and statuses as a table's watch. It sends the whole object, so a drawer no longer needs a table's watcher or a refetch.
- **Helm releases subscription (backend):** new `helm_releases_subscribe` and `helm_releases_unsubscribe` commands watch the Secrets Helm labels `owner=helm` (metadata only, no payload) and send one `changed` per burst of changes, so the releases screen can list again without polling. `forbidden` or `failed` end the subscription once; the screen then polls every 60 s. Releases kept in ConfigMaps or SQL are not seen. A cluster that refuses the cluster-wide `helm list` is also remembered for 60 s, so each refresh skips the call that cannot succeed.
- **One Pod watch for the table and the Map (backend):** with a Pods table and the Map open, the core now watches Pods once instead of twice; each view still gets its own, differently trimmed rows.
- **No idle wake-ups in watches (backend):** a watch subscriber's flush timer no longer ticks every 150 ms while nothing changes; it sleeps until a change, a status or a snapshot is queued. A change still reaches the interface within the same 150 ms batch.
- **Workload logs open fewer streams (backend):** a log session reads at most 20 containers at a time and queues the rest; a new `limited` marker (`{ type: "limited", streaming, total }`) tells how many run and how many exist, and a last one with `streaming == total` says nothing waits any more. Following a workload no longer reads each Pod again before its first stream.

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
