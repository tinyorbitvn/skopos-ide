# Changelog

What changed in each SkoposIDE release. Add notes under Unreleased as changes land on main;
`make release VERSION=x.y.z` dates them, and the release workflow publishes them as the
release notes (see `docs/releasing.md`).

## [Unreleased]

- **The catalog says what a kubeconfig does on connect:** a cluster whose kubeconfig runs an exec plugin or a `gcp` auth provider's command for credentials now shows an Exec plugin label that names the command, and one whose kubeconfig turns off TLS verification shows a TLS not verified label, both in the catalog and on the cluster's settings page. Before, the first was shown nowhere and the second only as a line in the connection log once a connect had started. A plugin's arguments and environment are not sent with the catalog.
- **The app asks before a kubeconfig runs a program:** a kubeconfig can name a program to run for credentials (an exec plugin, or a `gcp` auth provider's command), and until now connecting ran it at once. The first connect to such a cluster now shows the program, the cluster address and, on request, its arguments and environment, and runs it only after you allow it. The answer is remembered for that cluster until the program, its arguments, its environment or the address change, and Cluster settings has Stop allowing. After this update each cluster that uses such a program asks once.

## [0.12.0-rc.1] - 2026-11-22

- **Signed and notarized on macOS:** the macOS app and disk image are signed with a Developer ID certificate and notarized by Apple, so they open without Open Anyway or `xattr`. After this update macOS may ask once more for the passwords SkoposIDE keeps in the Keychain; choose Always Allow. Later updates keep access.

## [0.11.0] - 2026-11-22

- **Close a drawer from anywhere outside it:** a click anywhere outside a drawer, such as on the sidebar, a tab, the header, the dock, the list's toolbar, a column header or the empty space under the rows, now closes it, where only the dimmed list around it did. A click on another row of the list, or on a node or a pod of the topology page, still shows it in the drawer, and a click in a menu or dialog the drawer opened leaves it open. When the click puts focus in a box, such as the filter box, focus stays there.
- **License:** SkoposIDE is source-available under the PolyForm Shield License 1.0.0, not open source. People and companies may use it free of charge, change it and share it, but not to provide a product that competes with it. The third-party code, icons and packages in the app keep their own licenses, listed in `THIRD_PARTY_NOTICES.md`, whose License texts section now holds the Apache License 2.0 text too.
- **Project site:** the landing page's pictures now come from the app's design canvas: the Pods list with a Pod's details, in the dark theme at the top and the light theme under Themes, and on every feature card its own screen: the catalog, a YAML edit tab with the API docs, logs in the dock, the resource map, a Pod's metrics, Helm releases and Argo CD Applications, the Pods list, the About dialog and the command palette. Further cards show tabs and split panes side by side, the cluster Overview, the Node topology, filtering by any column and the AI agents panel, the last two marked Next release. A click on a card's picture, or Enter on it, opens it larger over the page. A Sponsor link in the menu and the footer leads to GitHub Sponsors. A new Metrics setup page, linked from the menu, the metrics card and the footer, lists the metrics sources, each cluster setting, the series every chart reads, how to install and check a source, and what each metrics message asks you to check.
- **Filter by any column:** a list's filter box now searches every column, the hidden ones too, so typing a status, a node, an IP or an age finds the rows that show it. Name a column to filter by it alone, as in `status = Running`, `node : worker-1` or `ip !: 10.244`, and compare numbers and times with `>` and `<`, as in `restarts > 0` or `age < 1h`. The suggestions list the columns, their operators and their values, and a row that matched through a hidden column says so beside its name. Text that starts with a column's name, such as `node=worker`, now filters that column; `label:node = worker` still finds the label.

## [0.10.0] - 2026-11-21

- **A sidebar closer to its design:** sections start closed, except the one that holds the page on screen, and each cluster keeps the ones you open; the Argo CD branch starts closed too. Rows use the label type with brighter kind names, and section icons are dimmer than their names except on the current page. With no cluster picked, the switcher says "Pick a cluster" instead of a line cut short, and the version under its name drops build metadata (v1.37.0, not v1.37.0+rke2r1). Once the sidebar is scrolled, a hairline under the switcher marks where its rows go instead of leaving one cut in half. The cluster menu opens just under the switcher, the collapse handle has a border, and the rail and its flyouts have the design's spacing. The hotbar and the sidebar take the design's glass colour, a pale blue in the light theme and a deep navy in the dark one, instead of plain grey.
- **Close a drawer with a click beside it:** a click on the dimmed screen around any drawer, such as an object's, a Helm release's or a port forward's, closes it as Close does, and focus goes back where it was. A click on another row of the list still shows that row in the drawer, and a click on the list's toolbar, its row of filters or its column headers leaves the drawer open. The drawer stays open while a ConfigMap or Secret in it has unsaved edits, and when the press started inside it, as for a resize or a text selection.
- **Node topology:** Nodes in the sidebar now holds List, the table as before, and Topology, a page that draws the cluster as an architecture diagram: a cluster box holding dashed region and zone boxes, with a card for each node. Each card shows the node's health, roles, conditions and taints, two donuts for its CPU and memory against what the node can give (from metrics-server when it serves them, else from the pods' requests), and its pods as small squares colored by status. Filter the nodes by name or label, highlight a namespace, and open a node or a pod in the drawer from its card, with the mouse or the keyboard. The palette's Node topology command opens the page.
- **Updates from inside the app:** SkoposIDE checks for a newer release 10 seconds after it starts and every 6 hours. When one is out, a toast and an Update button in the status bar offer it once per version. Check for Updates… in the Help menu, the macOS app menu and the command palette checks at once. The update dialog shows the release notes; Install and Restart downloads the release, checks its signature, installs it and restarts with your windows and tabs as they were. Skip This Version hides a release until a newer one is out, and Preferences > Updates turns the automatic checks off. From this version on, SkoposIDE updates itself; 0.9.0 and earlier need this one installed by hand.
- **Secret values stay out of Helm manifests:** the manifest of a release, and the one a preview renders, shows each Secret's keys with their values hidden. A document that cannot be read and names a Secret is hidden whole.
- **Safer paste in terminals:** control characters are removed from pasted text, whichever way it is pasted, so text copied from a cluster cannot end the paste early and run commands in a local shell. Links in terminal output open through the same check as every other link.
- **Windows stay on the app's own pages:** a window refuses to load any other page, and a file or link dropped on a window no longer opens in it.
- **The app asks where to save, not the page:** a log download, a map export and a ServiceAccount kubeconfig are saved where you choose in a dialog the app itself opens, so the interface never names the file to write. A map's save dialog now opens once its image is drawn.
- **A window's watches end with it:** when a window reloads or closes, the lists, detail panels, resource map, node topology and Helm release list it was following stop being watched, where they could keep running in the background. Other windows keep theirs.
- **A reconnect sends only what changed:** when a watch reconnects or its resource version expires, the lists and the resource map receive only the rows that changed meanwhile, where every row was sent and drawn again.
- **Slow metrics no longer pile up:** a metrics-server read that takes longer than the 15 s between polls is waited for and shown, where its answer was dropped and usage never appeared, and a read gives up after 10 s with a message. The Nodes list asks the kubelets for disk use only while the window shows, and not while its last read is still under way.
- **Fewer short freezes:** a keychain that waits, for an unlock prompt or a locked keyring, no longer holds up the app's other requests, and a window that takes focus no longer waits for a settings or layout file to be written.
- **Long lists and long manifests stay responsive:** when new objects arrive in a long list, only the new rows are put in their place, where the whole list was sorted again. A manifest of more than 50,000 characters is checked for YAML errors once the typing pauses, where it was parsed again at every key, and Save and Apply wait for that check.
- **Lists load only the namespaces they show:** a table with namespaces chosen, a Service's endpoints, a workload's Logs tab, its usage charts and the Pods in a drawer now receive only the objects of those namespaces, where every object in the cluster was sent and then filtered. In a large cluster these open faster and use far less memory. The namespace filter now offers the cluster's namespaces, including those with no object of the kind shown.
- **Large lists arrive in parts:** a list of thousands of objects now reaches the window in parts of at most 2,000 rows, so the window keeps responding while the list loads, where it stopped for a moment to read the whole list at once.
- **Events and Applications lists hold less:** the Events tables and the Argo CD Applications list now keep only the fields their columns and row actions read, where each row held the whole object. In a cluster with many Events or Applications they open faster and use less memory. A detail panel still reads the whole object when it opens.
- **Namespaces are listed a few at a time:** when your account may not list a kind in every namespace, the app lists it in each namespace. It now lists at most 16 namespaces of a cluster at one time, where it asked for all of them at once, which could be hundreds of requests.
- **The resource map asks how large the cluster is first:** a map with no saved namespaces first reads only how many resources each namespace holds. It then loads the whole map when that is at most 1,500 resources, and otherwise only the namespace it keeps, where it loaded every resource of the cluster and then dropped most of them.
- **The Workloads overview loads only the namespaces it shows:** with namespaces chosen, the overview now receives only their workloads and events, and waits for the saved choice before it asks, where it loaded every workload and event of the cluster and then filtered them.
- **A Node's Pods no longer load the whole cluster:** the Pods part of a Node's detail panel now asks the cluster for the Pods on that node only, where it loaded every Pod of the cluster to show a few. In a large cluster it opens at once and uses far less memory.
- **Closing the window always quits:** if quitting stalls for 20 seconds after the main window closes, the app now ends itself, where it could stay running with no window. Each step of the quit is written to the app's log, so a stall shows how far it got.
- **Hardening:** the app's settings, data, log and cache folders are kept to your user account, a failed access review no longer logs text the server sent, the connection log warns when a kubeconfig turns off TLS verification, and the content security policy forbids frames, plugins, form posts and a changed base address.
- **A cluster Overview you can read at a glance:** the Overview is now a grid of cards that fills the page. Capacity shows the cluster's CPU, memory and Pods as donuts against what its nodes can give, from metrics-server's usage or else the Pods' requests, with the requests' share beside. Health counts nodes ready, Pods by status, workloads with problems and Warning events of the last hour, under the namespaces the lists are filtered to, and each tile opens its list. Top consumers ranks the namespaces and Pods that use the most CPU or memory, with their share of the cluster, and opens them in the drawer. The cluster's facts and control plane checks sit in a card of their own.
- **Control plane metrics:** under Prometheus, the Overview's Metrics card adds API requests with their 5xx errors, API latency, etcd latency and the etcd database's size, read from the API server's own metrics so that EKS, GKE and AKS show them too. The charts sit under the cluster's own, share their range, view and hover, and line up four, two or one to a row as the card's width allows.
- **Section overviews:** Nodes, Namespaces, Network and Storage now open on an overview, the first entry of their section in the sidebar and in its rail flyout, also listed among the command palette's pages and as a command each. Nodes shows the cluster's capacity, its nodes by state, the busiest nodes by CPU or memory, a table by zone and the kubelet versions, OS images and architectures in use. Namespaces ranks the namespaces that use the most CPU or memory, counts those Terminating or holding a ResourceQuota or LimitRange, shows each quota's use as donuts and the Pods and workloads of each namespace. Network counts Services by type, Ingresses, Gateways and NetworkPolicies, shows the share of ready endpoints with the Services that have none, every host of the Ingresses and routes, and the external address of each load balancer. Storage ranks the mounted claims by the bytes they use, as each node's kubelet reports them, counts claims and volumes by phase, says why a claim is not Bound and compares each StorageClass's requested and provisioned capacity. Each tile opens its list and each row its object in the drawer; a kind your account may not list or the cluster does not serve turns only its own tile or card into the reason. Namespaces in the sidebar is now a section of Overview and List.
- **The Workloads overview at a glance:** the Workloads overview is now a grid of cards, as the cluster Overview is. A tile per kind counts its objects with the failing and pending ones and opens its list; Health shows the share of healthy workloads in a donut, with a table by kind; Workloads with problems lists the failing ones first, then the pending ones, up to 50; and Recent events shows the 8 newest events. Each row opens its object in the drawer. The page follows the namespaces chosen in the lists and names them at the top, where it had a namespace filter of its own, and its tab now reads Workloads overview.

## [0.9.0] - 2026-11-20

- **A glass sidebar in groups:** the cluster switcher and the sidebar share one glass-tinted column, 248 px wide by default; drag its edge between 200 and 360 px, or double-click it to reset. Overview and Resource map come first, then Apps (Helm, and Argo with Argo CD inside it), Cluster (Nodes, Namespaces, Events) and Resources. Each section has its icon, Helm and Argo show their project logos, and a section with one screen is a plain link. The kinds of an open section hang on tree lines, the current page has a soft highlight, and a kind open in another tab of the window shows a small dot. The switcher shows the cluster's tile with a status dot, its distribution and version, and its name.
- **Collapse the sidebar to icons:** the round handle on the sidebar's edge, Ctrl+B (Cmd+B on macOS) or the palette's Collapse the sidebar command shrink it to a 64 px rail of section icons, and each window remembers its choice. A section with several kinds opens a flyout of them beside the rail: Up, Down, Home and End move in it, Escape closes it, and choosing a kind opens it as the sidebar does.
- **Calmer menus, dialogs and panes:** menus are wider, with a divider between groups; dialogs sit higher on a scrim without blur; the command palette has an inset search field. While a tab is dragged, the drop zones are easier to see, and the label beside the pointer turns red over a pane that cannot take the tab. A splitter shows an accent line while you drag it, and the selected tab has a Tab actions button that opens its menu.
- **New icons:** the app's icons are now theSVG UI's filled drawings, and they no longer move when you
  point at or focus their button or menu item. In the command palette each kind and section has an
  icon of its own, such as a pod for Pods, a load balancer for Services, a namespace for Namespaces,
  an event stream for Events, a permission group for Access Control and a GPU for Device Resources.
- **One Create menu in the dock, and several terminals:** the dock's Create button opens a menu upward with Create resource and Terminal session. Each Terminal session opens a new local terminal, named Terminal, Terminal 2 and so on, each with its own shell, and they all come back after a restart. The header no longer has a Terminal button; Ctrl+` still brings the open terminal forward.
- **Copy any field of the drawer:** every field of an object's drawer, such as a Pod's Node or IP and each container's image, ports and environment, has a copy button that shows while you point at the row. It copies the value as shown, a line per line, without the buttons beside it. The Summary's values, each container's and volume's name, each label or selector chip and the summary of a row that opens (Tolerations, Labels) have one too.
- **Select text in the drawer:** the whole body of an object's drawer is text you can select and copy with the keyboard; its buttons, tabs and chevrons are not. A click that ends a selection in a row that opens leaves the row as it was.
- **Resize a PersistentVolumeClaim:** Resize on a claim's drawer or row menu asks for a larger size, such as 20Gi. The dialog shows the claim's capacity, what it asks for and whether its StorageClass allows volume expansion, and says why when the claim cannot grow: it is not Bound, it has no StorageClass, or its class does not allow it. The size must be larger than the current capacity.
- **Resize table columns:** drag the right edge of a column's header, or focus it and use Left and Right, to make the column wider or narrower; a double-click gives it back its own width. Each kind's list keeps the widths it was given, after a restart too.
- **Usage bars on Nodes:** the Nodes list draws each node's CPU and Memory as a bar of what the node can give (its allocatable), with the share beside it and both amounts on hover. A Disk bar shows the node's root filesystem, read from its kubelet through the API server every 30 seconds; without access to `nodes/proxy` the column says so on hover. A bar turns orange from 80% and red from 95%.
- **Device Resources:** a new sidebar section lists the Dynamic Resource Allocation kinds a cluster serves: ResourceClaims, ResourceClaimTemplates, DeviceClasses and ResourceSlices. A claim shows its state (Pending, Allocated or Reserved), the Pods that hold it, its requests and the devices it was given; a slice shows its driver, node, pool and each device's attributes and capacity.
- **Every drawer looks the same:** the drawers of Helm releases, Helm charts and port forwards now float over their list like an object's drawer, with the same dimmed screen, resize handle and header: the kind above the name, icon buttons for the actions, then Close. They share the object drawer's width.
- **Lighter on large clusters:** going back to a list within 20 seconds shows it at once instead of loading it again, and a minimized window or a hidden Logs tab stops drawing until it is shown. A table redraws only the rows that changed and counts its filter suggestions only while the filter box has focus. Lists of Nodes, ConfigMaps, ReplicaSets and CustomResourceDefinitions carry only the fields they show, and an object's drawer, Logs and Shell tabs follow that one object instead of its whole list. A Pods table and the Map open together share one watch, and a watch with nothing to send no longer wakes up every 150 ms. Helm Releases refreshes when a release stored in a Secret (Helm's default) changes, instead of asking Helm every 15 seconds; where the cluster does not allow that watch, it asks every 60 seconds and again when you come back to the window after that long. A workload's Logs follow at most 20 containers at a time and say how many of how many. The usage history behind the Metrics charts is kept only while a Metrics panel is open, and no longer grows by tens of megabytes an hour. The command palette prepares each name once and waits 100 ms between keys on very large clusters, terminal output is acknowledged in batches, the Force map layout continues from the last positions instead of starting over, and every view of a cluster shares one API discovery.
- **A faster resource map:** zooming, panning and selecting no longer redraw the whole map, and a new snapshot of the same graph redraws only what changed. With 1,500 resources on the map, a zoom step takes about 10 ms instead of half a second, and dragging a node draws once per frame.
- **Remove a key with an icon:** each key of a Secret or ConfigMap has a trash icon instead of a Remove button, and a removed key shows an undo icon.
- **Windows terminals no longer stay blank:** Windows asks a new terminal for its cursor position before it prints anything, and waits for the answer. When that question came before the session was ready, the answer was lost and the terminal stayed empty. Early output now waits until the session can answer it.
- **Control plane on the Overview:** a cluster's Overview starts with its control plane: the API server's version, address and `/livez` and `/readyz` checks (each failing check named), then etcd, the scheduler, the controller manager, DNS and kube-proxy, each healthy, degraded or unhealthy with what that rests on, such as ready Pods, the leader's last renewal or the readyz check. A part the provider runs, or that you may not read, shows as not visible instead of failing. The section reads again every 30 seconds.

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

## [0.5.0] - 2026-11-14

### In the app

- **Details drawer:**
  - it floats over the list on a dimmed backdrop instead of narrowing it;
  - its sections are cards that open and close, and the app remembers which ones you closed for each kind;
  - related objects are links that open in the same drawer, with Back to return: the owner, Node, Namespace, ServiceAccount, Priority class, and the ConfigMaps, Secrets and PersistentVolumeClaims a Pod mounts;
  - a Pod's Overview is laid out as Summary, Relations, Volumes, Scheduling, Containers and Metadata, and workload kinds show their Pod template's volumes and service account the same way.
- **Workloads overview:** counts Pods, Deployments, DaemonSets, StatefulSets, ReplicaSets, Jobs and CronJobs as Healthy, Pending or Failing, and lists the 10 newest events, in the namespaces the lists are filtered to.
- **Sidebar:** Custom Resources are grouped by domain, then API group, then kind, for example `k8s.io` › `gateway.networking` › Gateways.
- **Resource map:**
  - a filters row with Namespaces and Kinds menus, Clear filters, and a count of what is shown;
  - hidden kinds are bridged, so a Pod still links to its Deployment when ReplicaSets are hidden.
- **Secrets:** Reveal and Hide are an eye icon button.
- **Fixes:**
  - the header no longer pushes Disconnect onto a second line on the Resource map at the default window size;
  - long cell text no longer shows through the Actions column when you hover a row.

## [0.4.0] - 2026-11-14

### In the app

- **Argo CD:**
  - an Argo CD section in the sidebar, shown when the cluster serves the Argo CD resources;
  - Applications, ApplicationSets and AppProjects lists, with Project, Sync, Health and Revision for Applications;
  - drawers with an Application's sources, last operation, resources and history, an ApplicationSet's generators, generated Applications and template, and an AppProject's destinations, repositories, sync windows and Applications;
  - Sync with Prune, Dry run, Apply only, Force and a revision; it asks you to confirm first when the project may have sync windows;
  - Refresh, Hard refresh, Terminate and Roll back;
  - delete one or several Applications, with or without the resources they deployed.
- **Sidebar:**
  - the Gateway API lists move from Custom Resources to Network;
  - each Custom Resources group opens and closes, shows how many kinds it has, and opens by itself when you are on one of its pages;
  - resize the navigation and the details drawer by dragging their edge or with the arrow keys; double-click resets them, and the app keeps both widths between runs.
- **Resource map:** the map fills the page under its toolbar again.

### In the core

- **Access checks:** "Loading resources" finishes much sooner on large clusters. A cluster admin needs a single access review instead of one per kind and verb, and other users get one rules review per namespace, with access reviews only for what the rules cannot settle.

### Security

- The end-to-end test tools move to wdio 10.2, with glob and minimatch past their advisories. These packages are not part of the app.

## [0.3.0] - 2026-11-13

### In the app

- **Helm:**
  - a Helm section in the sidebar and the palette;
  - Charts and Releases lists, each with a drawer;
  - install and upgrade from a page with values and a preview;
  - roll back and uninstall dialogs;
  - chart READMEs shown as markdown, never as HTML.
- **Tools and repositories in Preferences:** see helm and kubectl, with their downloads, and manage Helm repositories.
- **Metrics:**
  - gauges and a Metrics section on the cluster Overview;
  - a Metrics tab in the drawer;
  - CPU and Memory columns in the Pods and Nodes tables;
  - charts that also read as a table.
- **Cluster settings:** a Settings page for each cluster, opened from the header, the catalog or the palette. It chooses Prometheus, metrics-server or no metrics for that cluster.
- **Resource map:**
  - a map of a cluster's objects and how they connect: owners, selectors, routes, mounts, env references, service accounts, volume claims and classes;
  - Grouped, Layered and Force layouts, namespace filters, search and a details pane;
  - an object map around any resource, 1 or 2 hops deep;
  - a Resource map tab in the drawer;
  - icons from the Kubernetes Icons Set.
- **Gateway API:** GatewayClass, Gateway and HTTPRoute lists with their status, shown when the cluster serves them.
- **Workspace:**
  - several clusters side by side, in up to three panes;
  - tabs you can pin, drag between panes and split;
  - each pane has compact Overview, Pods and Events views;
  - the layout is kept across restarts;
  - open it from the hotbar (Shift-click opens a new pane) or the palette.

### In the core

- **Resource graph:** a live graph of a cluster's objects and their relations, with a namespace view, for the map.
- **Pods:** the Pod rows keep each container's image.
- **Helm:** a release's manifest, and uninstall that keeps the history.

### Security

- The editor's dompurify is now 3.4.17, which fixes the advisories reported against 3.4.15.

## [0.2.0] - 2026-11-10

### In the app

- **Logs dock:** open Logs tabs from Pods and workloads, follow a workload's pods, search, autoscroll and download. Prefixes, colors and level detection are included. The dock layout is kept across restarts.
- **Terminals:** local terminal, Shell and Attach on Pods, and a node shell on Nodes, as dock tabs with their own toolbars. Open them with the Terminal button or Ctrl+`.
- **Port forwarding:** start forwards from Pods, Services and their ports, and see them on their own screen with a drawer and a running count. Forwards persist.
- **Application shell:** command palette, Keyboard shortcuts dialog, About, header with a Help menu, and the macOS menu.
- **Object actions:**
  - force delete and force finalize;
  - suspend and resume a Job;
  - set the default IngressClass;
  - save a ServiceAccount kubeconfig with a token;
  - copy buttons in the drawer.
- **Theme:** choose it with a segmented control.

### In the core (screens follow in a later release)

- **Tools:** finds helm and kubectl, or downloads the pinned versions, with progress.
- **Helm:**
  - repositories and chart search;
  - releases with detail, values and history;
  - install, upgrade, rollback and uninstall with previews.
- **Metrics:**
  - detects Prometheus or metrics-server for each cluster;
  - queries Prometheus through the service proxy for clusters, nodes, workloads, pods and PVCs;
  - reads metrics-server snapshots.
- **Argo CD:** sync, roll back, terminate an operation, refresh, and delete an Application.
