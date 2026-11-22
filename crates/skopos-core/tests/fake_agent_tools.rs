//! The `skopos` MCP server's read tools against the fake API server, through an in-process
//! MCP client over a duplex pipe, as an agent calls them. The Helm tools run a fake `helm`
//! shell script, so this file runs on Unix.
#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation,
};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceError, ServiceExt};
use serde::Deserialize;
use serde_json::{json, Value};
use skopos_core::agents::endpoint::AsyncStream;
use skopos_core::agents::mcp::trim::RESULT_CAP;
use skopos_core::agents::mcp::{
    scope_names, serve_mcp, CardDetails, CardTone, NoChanges, ScopeCluster, ToolCard, ToolContext,
    ToolScope,
};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::{CoreResult, ErrorCode};
use skopos_core::helm::HelmHomes;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::ClusterAgentSettings;
use skopos_core::tools::ToolsConfig;
use skopos_fakekube::{DenyRule, FakeKubeConfig, FakeLogLine};
use support::connected_fake;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// A cluster of a global chat that is in no catalog, so it is never connected.
const GHOST: &str = "0123456789abcdef0123456789abcdef";

const READ_TOOLS: [&str; 8] = [
    "list_kinds",
    "list_objects",
    "get_object",
    "get_events",
    "get_logs",
    "get_usage",
    "list_helm_releases",
    "get_helm_release",
];

/// One chat's MCP session: the agent's end, and the cards the panel would draw.
struct Chat {
    client: RunningService<RoleClient, ClientConfig>,
    cards: mpsc::Receiver<ToolCard>,
    _server: JoinHandle<CoreResult<()>>,
}

async fn open(core: &AppCore, scope: ToolScope) -> Chat {
    let (cards_tx, cards) = mpsc::channel(64);
    let ctx = Arc::new(ToolContext {
        core: core.clone(),
        scope,
        cards: cards_tx,
        gate: Arc::new(NoChanges),
    });
    let (server_end, client_end) = tokio::io::duplex(1 << 20);
    let stream: Box<dyn AsyncStream> = Box::new(server_end);
    let server = tokio::spawn(serve_mcp(stream, ctx));
    let client = ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("skopos-test", "1.0.0"),
    )
    .serve(client_end)
    .await
    .expect("the MCP handshake");
    Chat {
        client,
        cards,
        _server: server,
    }
}

impl Chat {
    /// Calls a tool and returns its result and its done card, after checking that the
    /// call sent exactly two cards: running, then done, under one id and title.
    async fn call(&mut self, tool: &'static str, arguments: Value) -> (CallToolResult, ToolCard) {
        let result = self
            .send(tool, arguments)
            .await
            .expect("the call is answered");
        let running = self.card().await;
        let done = self.card().await;
        assert!(running.running, "{running:?}");
        assert!(!done.running, "{done:?}");
        assert_eq!(running.id, done.id);
        assert_eq!(running.title, done.title);
        assert!(running.result.is_empty(), "{running:?}");
        assert!(self.cards.try_recv().is_err(), "one call sends two cards");
        (result, done)
    }

    async fn send(
        &self,
        tool: &'static str,
        arguments: Value,
    ) -> Result<CallToolResult, ServiceError> {
        let Value::Object(arguments) = arguments else {
            panic!("arguments are an object");
        };
        self.client
            .call_tool(CallToolRequestParams::new(tool).with_arguments(arguments))
            .await
    }

    /// A call refused before it reached a cluster: a tool error, and no card.
    async fn refused(&mut self, tool: &'static str, arguments: Value) -> String {
        let result = self
            .send(tool, arguments)
            .await
            .expect("the call is answered");
        assert_eq!(result.is_error, Some(true));
        assert!(
            self.cards.try_recv().is_err(),
            "a refused call draws no card"
        );
        text(&result)
    }

    async fn card(&mut self) -> ToolCard {
        tokio::time::timeout(Duration::from_secs(5), self.cards.recv())
            .await
            .expect("a card in time")
            .expect("the server holds the sender")
    }
}

fn one_cluster(id: &ClusterId) -> ToolScope {
    ToolScope {
        clusters: vec![ScopeCluster {
            id: id.clone(),
            name: "fake".to_owned(),
        }],
        global: false,
    }
}

fn across(id: &ClusterId) -> ToolScope {
    ToolScope {
        clusters: scope_names(&[
            (id.clone(), "fake".to_owned()),
            (GHOST.to_owned(), "ghost".to_owned()),
        ]),
        global: true,
    }
}

fn text(result: &CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|block| block.as_text())
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The YAML documents of a result that are objects: a list's items, without the line
/// that says how many it shows.
fn documents(text: &str) -> Vec<Value> {
    serde_yaml_ng::Deserializer::from_str(text)
        .map_while(|document| Value::deserialize(document).ok())
        .filter(Value::is_object)
        .collect()
}

fn names(documents: &[Value]) -> Vec<&str> {
    documents
        .iter()
        .map(|document| document["metadata"]["name"].as_str().unwrap_or_default())
        .collect()
}

fn rows(card: &ToolCard) -> Vec<Vec<String>> {
    match &card.details {
        CardDetails::Table { rows, .. } => rows.clone(),
        other => panic!("not a table: {other:?}"),
    }
}

fn head(card: &ToolCard) -> Vec<String> {
    match &card.details {
        CardDetails::Table { head, .. } => head.clone(),
        other => panic!("not a table: {other:?}"),
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn set_agent(core: &AppCore, id: &ClusterId, agent: ClusterAgentSettings) {
    let mut settings = core.cluster_settings_get(id);
    settings.agent = agent;
    core.cluster_settings_set(id, settings).unwrap();
}

fn limited_to(namespaces: &[&str]) -> ClusterAgentSettings {
    ClusterAgentSettings {
        namespaces: Some(strings(namespaces)),
        ..ClusterAgentSettings::default()
    }
}

fn with_shop() -> FakeKubeConfig {
    FakeKubeConfig {
        namespaces: strings(&["default", "kube-system", "shop"]),
        ..FakeKubeConfig::default()
    }
}

fn pod(namespace: &str, name: &str, app: &str) -> Value {
    json!({
        "metadata": { "name": name, "namespace": namespace, "labels": { "app": app } },
        "spec": { "containers": [{ "name": "main", "image": "registry.k8s.io/pause:3.10" }] },
        "status": { "phase": "Running" },
    })
}

fn secret(name: &str) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "managedFields": [{ "manager": "kubectl" }],
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"c2VjcmV0\"}}",
            },
        },
        "type": "Opaque",
        "data": { "password": "c2VjcmV0", "user": "YWRtaW4=" },
        "stringData": { "token": "plain" },
    })
}

#[allow(clippy::too_many_arguments)]
fn event(
    namespace: &str,
    name: &str,
    kind: &str,
    object: &str,
    severity: &str,
    reason: &str,
    count: u64,
    last: &str,
) -> Value {
    json!({
        "metadata": { "name": name, "namespace": namespace },
        "involvedObject": { "kind": kind, "name": object, "namespace": namespace },
        "type": severity,
        "reason": reason,
        "message": format!("{reason} on {object}"),
        "count": count,
        "lastTimestamp": last,
    })
}

fn pod_metrics(namespace: &str, name: &str, cpu: &str, memory: &str) -> Value {
    json!({
        "metadata": { "name": name, "namespace": namespace },
        "timestamp": "2026-11-22T10:00:00Z",
        "window": "20s",
        "containers": [{ "name": "main", "usage": { "cpu": cpu, "memory": memory } }],
    })
}

const HELM_LIST: &str = r#"[{"name":"web","namespace":"shop","revision":"2","updated":"2026-11-09 09:25:49.373528822 +0700 +07","status":"deployed","chart":"skopos-fixture-0.2.0","app_version":"1.1.0"},{"name":"api","namespace":"default","revision":"1","updated":"2026-11-09 09:20:00 +0700 +07","status":"failed","chart":"skopos-fixture-0.1.0","app_version":"1.0.0"}]"#;

const HELM_STATUS: &str = r#"{"name":"web","info":{"first_deployed":"2026-11-09T09:25:49.373528822+07:00","last_deployed":"2026-11-09T09:30:12.1+07:00","description":"Upgrade complete","status":"deployed","notes":"Thanks for installing."},"manifest":"---\n# Source: fixture/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: web-secret\ndata:\n  password: c2VjcmV0\n---\n# Source: fixture/templates/configmap.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\ndata:\n  greeting: hello\n","version":2,"namespace":"shop"}"#;

const HELM_HISTORY: &str = r#"[{"revision":1,"updated":"2026-11-09T09:25:49.373528822+07:00","status":"superseded","chart":"skopos-fixture-0.1.0","app_version":"1.0.0","description":"Install complete"},{"revision":2,"updated":"2026-11-09T09:30:12.1+07:00","status":"deployed","chart":"skopos-fixture-0.2.0","app_version":"1.1.0","description":"Upgrade complete"}]"#;

/// Makes `core` run a fake helm 4 that prints the fixtures above, with helm's folders in
/// the returned temp dir.
fn fake_helm(core: &AppCore) -> TempDir {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = format!(
        "#!/bin/sh\n\
         case \"$1\" in\n\
         version) printf '%s' 'v4.3.1';;\n\
         list) printf '%s' '{HELM_LIST}';;\n\
         status) printf '%s' '{HELM_STATUS}';;\n\
         history) printf '%s' '{HELM_HISTORY}';;\n\
         esac\n"
    );
    std::fs::write(bin.join("helm"), script).unwrap();
    std::fs::set_permissions(bin.join("helm"), std::fs::Permissions::from_mode(0o755)).unwrap();
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(bin.into_os_string()),
        ..ToolsConfig::default()
    });
    core.set_helm_homes_for_test(HelmHomes {
        config: root.path().join("helm/config"),
        cache: root.path().join("helm/cache"),
        data: root.path().join("helm/data"),
    });
    root
}

#[tokio::test]
async fn a_chat_on_one_cluster_lists_the_read_tools_without_a_cluster_argument() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let chat = open(&core, one_cluster(&id)).await;
    let info = chat
        .client
        .peer_info()
        .expect("the server introduced itself");
    let server_info = info.server_info.as_ref().expect("the server named itself");
    assert_eq!(server_info.name, "skopos");

    let tools = chat.client.list_all_tools().await.unwrap();
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    assert!(names.starts_with(&READ_TOOLS), "{names:?}");
    for tool in &tools {
        assert!(
            tool.input_schema["properties"].get("cluster").is_none(),
            "{}",
            tool.name
        );
    }
    let required = |name: &str| {
        tools
            .iter()
            .find(|tool| tool.name == name)
            .map(|tool| tool.input_schema["required"].clone())
            .unwrap()
    };
    assert_eq!(required("list_kinds"), json!([]));
    assert_eq!(required("list_objects"), json!(["kind"]));
    assert_eq!(required("get_object"), json!(["kind", "name"]));
    assert_eq!(required("get_events"), json!([]));
    assert_eq!(required("get_logs"), json!(["namespace", "pod"]));
    assert_eq!(required("get_usage"), json!(["of"]));
    assert_eq!(required("list_helm_releases"), json!([]));
    assert_eq!(required("get_helm_release"), json!(["namespace", "name"]));
}

#[tokio::test]
async fn a_chat_across_clusters_adds_list_clusters_and_a_cluster_argument() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let chat = open(&core, across(&id)).await;
    let tools = chat.client.list_all_tools().await.unwrap();
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    assert_eq!(names[0], "list_clusters");
    assert!(names[1..].starts_with(&READ_TOOLS), "{names:?}");
    assert_eq!(tools[0].input_schema["properties"], json!({}));
    for tool in &tools[1..] {
        assert_eq!(
            tool.input_schema["properties"]["cluster"]["enum"],
            json!(["fake", "ghost"]),
            "{}",
            tool.name
        );
        assert_eq!(tool.input_schema["required"][0], "cluster", "{}", tool.name);
    }
}

#[tokio::test]
async fn list_clusters_names_each_cluster_with_its_state_and_settings() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            namespaces: Some(strings(&["default"])),
            secret_values: true,
            ..ClusterAgentSettings::default()
        },
    );
    let version = match core.cluster_state(&id) {
        ConnectionState::Connected { info } => info.version,
        other => panic!("{other:?}"),
    };
    let mut chat = open(&core, across(&id)).await;

    let (result, card) = chat.call("list_clusters", json!({})).await;
    assert_eq!(card.title, "List clusters");
    assert_eq!(card.result, "2 clusters");
    assert_eq!(card.cluster, None);
    assert_eq!(card.tone, CardTone::Normal);
    assert_eq!(head(&card), ["Cluster", "State"]);
    assert_eq!(
        rows(&card),
        [
            strings(&["fake", "connected"]),
            strings(&["ghost", "disconnected"])
        ]
    );
    assert_eq!(
        documents(&text(&result)),
        [
            json!({
                "name": "fake",
                "state": "connected",
                "version": version,
                "changes": "Ask every time",
                "namespaces": ["default"],
                "secretValues": "readable",
                "commandsInContainers": "off",
            }),
            json!({
                "name": "ghost",
                "state": "disconnected",
                "changes": "Ask every time",
                "namespaces": "all",
                "secretValues": "hidden",
                "commandsInContainers": "off",
            }),
        ]
    );
}

#[tokio::test]
async fn list_kinds_lists_what_the_cluster_serves() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let served = core.resources_discover(&id, false).await.unwrap();
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat.call("list_kinds", json!({})).await;
    assert_eq!(card.title, "List kinds");
    assert_eq!(card.result, format!("{} kinds", served.len()));
    assert_eq!(card.cluster, None);
    let kinds = documents(&text(&result));
    assert_eq!(kinds.len(), served.len());
    assert!(
        kinds.contains(&json!({
            "kind": "Deployment",
            "name": "deployments.apps",
            "apiVersion": "apps/v1",
            "namespaced": true,
            "shortNames": ["deploy"],
        })),
        "{kinds:?}"
    );
    assert!(
        kinds.contains(&json!({
            "kind": "Secret",
            "name": "secrets",
            "apiVersion": "v1",
            "namespaced": true,
        })),
        "{kinds:?}"
    );
    assert_eq!(head(&card), ["Kind", "Name"]);
    assert_eq!(rows(&card).len(), served.len().min(20));
}

#[tokio::test]
async fn list_objects_returns_the_items_as_yaml_with_their_kind() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let mut web = pod("default", "web", "web");
    web["metadata"]["managedFields"] = json!([{ "manager": "kubectl" }]);
    web["metadata"]["annotations"] = json!({
        "kubectl.kubernetes.io/last-applied-configuration": "{}",
        "team": "shop",
    });
    fake.upsert("pods", web);
    fake.upsert("pods", pod("default", "api", "api"));
    fake.upsert("pods", pod("kube-system", "dns", "dns"));
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat.call("list_objects", json!({ "kind": "po" })).await;
    assert_eq!(card.title, "List Pods · all namespaces");
    assert_eq!(card.result, "3 Pods");
    assert_ne!(result.is_error, Some(true));
    let items = documents(&text(&result));
    let mut listed: Vec<(&str, &str)> = items
        .iter()
        .map(|item| {
            (
                item["metadata"]["namespace"].as_str().unwrap(),
                item["metadata"]["name"].as_str().unwrap(),
            )
        })
        .collect();
    listed.sort();
    assert_eq!(
        listed,
        [
            ("default", "api"),
            ("default", "web"),
            ("kube-system", "dns")
        ]
    );
    for item in &items {
        assert_eq!(item["kind"], "Pod");
        assert_eq!(item["apiVersion"], "v1");
    }
    let web = items
        .iter()
        .find(|item| item["metadata"]["name"] == "web")
        .unwrap();
    assert!(web["metadata"].get("managedFields").is_none(), "{web}");
    assert_eq!(web["metadata"]["annotations"], json!({ "team": "shop" }));
    assert_eq!(head(&card), ["Namespace", "Name"]);
    let mut table = rows(&card);
    table.sort();
    assert_eq!(
        table,
        [
            strings(&["default", "api"]),
            strings(&["default", "web"]),
            strings(&["kube-system", "dns"]),
        ]
    );

    let (result, card) = chat
        .call(
            "list_objects",
            json!({ "kind": "Pod", "namespace": "kube-system" }),
        )
        .await;
    assert_eq!(card.title, "List Pods · kube-system");
    assert_eq!(card.result, "1 Pod");
    assert_eq!(names(&documents(&text(&result))), ["dns"]);

    let (result, card) = chat.call("list_objects", json!({ "kind": "nodes" })).await;
    assert_eq!(card.title, "List Nodes");
    assert_eq!(card.result, "0 Nodes");
    assert_eq!(text(&result), "0 Nodes");
    assert_eq!(card.details, CardDetails::None);
}

#[tokio::test]
async fn list_objects_applies_the_selectors_and_the_limit() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    for name in ["web-1", "web-2", "web-3"] {
        fake.upsert("pods", pod("default", name, "web"));
    }
    fake.upsert("pods", pod("default", "db-1", "db"));
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "list_objects",
            json!({ "kind": "pods", "namespace": "default", "label_selector": "app=web", "limit": 2 }),
        )
        .await;
    assert_eq!(card.title, "List Pods · default · app=web");
    assert_eq!(card.result, "3 Pods");
    let shown = text(&result);
    assert_eq!(documents(&shown).len(), 2);
    assert!(
        shown.ends_with("---\nShowing 2 of 3. Narrow the selector or the namespace.\n"),
        "{shown}"
    );

    let (result, card) = chat
        .call(
            "list_objects",
            json!({
                "kind": "pods",
                "namespace": "default",
                "label_selector": "app=web",
                "field_selector": "metadata.name=web-2",
            }),
        )
        .await;
    assert_eq!(
        card.title,
        "List Pods · default · app=web, metadata.name=web-2"
    );
    assert_eq!(card.result, "1 Pod");
    assert_eq!(names(&documents(&text(&result))), ["web-2"]);
}

#[tokio::test]
async fn a_listed_secret_has_blank_values_although_list_items_carry_no_kind() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("secrets", secret("db"));
    // What the API server answers: list items without `kind` or `apiVersion`.
    let client = core.cluster_client(&id).unwrap();
    let list: Value = client
        .request(
            http::Request::get("/api/v1/namespaces/default/secrets")
                .body(Vec::new())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(list["items"][0].get("kind").is_none(), "{list}");
    assert_eq!(list["items"][0]["data"]["password"], "c2VjcmV0");
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "list_objects",
            json!({ "kind": "secrets", "namespace": "default" }),
        )
        .await;
    assert_eq!(card.title, "List Secrets · default");
    assert_eq!(card.result, "1 Secret");
    let shown = text(&result);
    assert!(!shown.contains("c2VjcmV0"), "{shown}");
    assert!(!shown.contains("YWRtaW4="), "{shown}");
    let items = documents(&shown);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], "Secret");
    assert_eq!(items[0]["data"], json!({ "password": "", "user": "" }));
    assert_eq!(items[0]["stringData"], json!({ "token": "" }));
    assert!(items[0]["metadata"].get("managedFields").is_none());
    assert_eq!(items[0]["metadata"]["annotations"], json!({}));
}

#[tokio::test]
async fn a_list_over_64_kib_keeps_the_items_that_fit() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    for n in 0..30 {
        fake.upsert(
            "configmaps",
            json!({
                "metadata": { "name": format!("blob-{n:02}"), "namespace": "default" },
                "data": { "blob": "x".repeat(4_000) },
            }),
        );
    }
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "list_objects",
            json!({ "kind": "cm", "namespace": "default" }),
        )
        .await;
    assert_eq!(card.title, "List ConfigMaps · default");
    assert_eq!(card.result, "30 ConfigMaps");
    let shown = text(&result);
    assert!(shown.len() <= RESULT_CAP, "{}", shown.len());
    let fit = documents(&shown).len();
    assert!((10..30).contains(&fit), "{fit}");
    assert!(
        shown.ends_with(&format!(
            "---\nShowing {fit} of 30. Narrow the selector or the namespace.\n"
        )),
        "{}",
        &shown[shown.len() - 80..]
    );
    assert_eq!(rows(&card).len(), 20);
}

#[tokio::test]
async fn a_namespace_outside_the_limit_returns_nothing_with_its_note() {
    let (core, fake, id, _root) = connected_fake(with_shop()).await;
    fake.add_pod("default", "web");
    fake.add_pod("shop", "cart");
    set_agent(&core, &id, limited_to(&["shop"]));
    let note = "default is outside the namespaces the person lets agents see on fake: shop.";
    let pods_read = fake.request_count("/api/v1/namespaces/default/pods");
    let mut chat = open(&core, one_cluster(&id)).await;

    for (tool, arguments, title) in [
        (
            "list_objects",
            json!({ "kind": "pods", "namespace": "default" }),
            "List Pods · default",
        ),
        (
            "get_object",
            json!({ "kind": "pods", "namespace": "default", "name": "web" }),
            "Read Pod default/web",
        ),
        (
            "get_object",
            json!({ "kind": "namespaces", "name": "default" }),
            "Read Namespace default",
        ),
        (
            "get_events",
            json!({ "namespace": "default" }),
            "Read events · default",
        ),
        (
            "get_logs",
            json!({ "namespace": "default", "pod": "web" }),
            "Read logs · web · last 100 lines",
        ),
        (
            "get_usage",
            json!({ "of": "pods", "namespace": "default" }),
            "Read usage · Pods · default",
        ),
        (
            "list_helm_releases",
            json!({ "namespace": "default" }),
            "List Helm releases · default",
        ),
        (
            "get_helm_release",
            json!({ "namespace": "default", "name": "web" }),
            "Read Helm release default/web",
        ),
    ] {
        let (result, card) = chat.call(tool, arguments).await;
        assert_eq!(card.title, title);
        assert_eq!(text(&result), note, "{tool}");
        assert_eq!(card.result, note, "{tool}");
        assert_eq!(card.tone, CardTone::Normal, "{tool}");
        assert_ne!(result.is_error, Some(true), "{tool}");
    }
    assert_eq!(
        fake.request_count("/api/v1/namespaces/default/pods"),
        pods_read,
        "nothing in default was listed"
    );
    assert_eq!(fake.request_count("/api/v1/namespaces/default/pods/web"), 0);
    assert_eq!(
        fake.request_count("/api/v1/namespaces/default/pods/web/log"),
        0
    );

    let (result, card) = chat
        .call("list_objects", json!({ "kind": "namespaces" }))
        .await;
    assert_eq!(card.title, "List Namespaces");
    assert_eq!(card.result, "1 Namespace");
    assert_eq!(names(&documents(&text(&result))), ["shop"]);
}

#[tokio::test]
async fn a_list_without_a_namespace_reads_only_the_allowed_namespaces() {
    let (core, fake, id, _root) = connected_fake(with_shop()).await;
    fake.add_pod("default", "web");
    fake.add_pod("shop", "cart");
    fake.add_pod("kube-system", "dns");
    set_agent(&core, &id, limited_to(&["kube-system", "shop"]));
    let wide_pods = fake.request_count("/api/v1/pods");
    let shop_pods = fake.request_count("/api/v1/namespaces/shop/pods");
    let wide_events = fake.request_count("/api/v1/events");
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat.call("list_objects", json!({ "kind": "pods" })).await;
    assert_eq!(card.title, "List Pods · all namespaces");
    assert_eq!(card.result, "2 Pods");
    let items = documents(&text(&result));
    let mut listed = names(&items);
    listed.sort();
    assert_eq!(listed, ["cart", "dns"]);
    assert_eq!(
        fake.request_count("/api/v1/pods"),
        wide_pods,
        "no list of every namespace"
    );
    assert_eq!(
        fake.request_count("/api/v1/namespaces/shop/pods"),
        shop_pods + 1
    );

    let (_, card) = chat.call("get_events", json!({})).await;
    assert_eq!(card.title, "Read events · all namespaces");
    assert_eq!(card.result, "0 events");
    assert_eq!(fake.request_count("/api/v1/events"), wide_events);
    assert_eq!(fake.request_count("/api/v1/namespaces/shop/events"), 1);
}

#[tokio::test]
async fn get_object_returns_the_trimmed_object_and_hides_secret_values() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("secrets", secret("db"));
    fake.upsert("pods", pod("default", "web", "web"));
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "get_object",
            json!({ "kind": "Secret", "namespace": "default", "name": "db" }),
        )
        .await;
    assert_eq!(card.title, "Read Secret default/db");
    assert_eq!(card.result, "Found");
    let shown = text(&result);
    assert!(!shown.contains("c2VjcmV0"), "{shown}");
    let object = &documents(&shown)[0];
    assert_eq!(object["kind"], "Secret");
    assert_eq!(object["data"], json!({ "password": "", "user": "" }));
    assert!(object["metadata"].get("managedFields").is_none());
    assert_eq!(object["metadata"]["annotations"], json!({}));
    match &card.details {
        CardDetails::Text { text: first } => assert!(shown.starts_with(first.as_str())),
        other => panic!("not text: {other:?}"),
    }

    let (result, card) = chat
        .call(
            "get_object",
            json!({ "kind": "pods", "namespace": "default", "name": "web" }),
        )
        .await;
    assert_eq!(card.title, "Read Pod default/web");
    assert_eq!(card.result, "Found");
    assert_eq!(documents(&text(&result))[0]["kind"], "Pod");
}

#[tokio::test]
async fn get_object_on_a_secret_with_values_readable_returns_them() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("secrets", secret("db"));
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            secret_values: true,
            ..ClusterAgentSettings::default()
        },
    );
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "get_object",
            json!({ "kind": "secrets", "namespace": "default", "name": "db" }),
        )
        .await;
    assert_eq!(card.result, "Found");
    let object = &documents(&text(&result))[0];
    assert_eq!(
        object["data"],
        json!({ "password": "c2VjcmV0", "user": "YWRtaW4=" })
    );
    assert!(object["metadata"].get("managedFields").is_none());
    assert_eq!(object["metadata"]["annotations"], json!({}));

    let (result, _) = chat
        .call(
            "list_objects",
            json!({ "kind": "secrets", "namespace": "default" }),
        )
        .await;
    assert_eq!(documents(&text(&result))[0]["data"]["password"], "c2VjcmV0");
}

#[tokio::test]
async fn get_object_of_a_missing_object_is_not_found() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "get_object",
            json!({ "kind": "pods", "namespace": "default", "name": "missing" }),
        )
        .await;
    assert_eq!(card.title, "Read Pod default/missing");
    assert_eq!(card.result, "Not found");
    assert_eq!(card.tone, CardTone::Normal);
    assert_ne!(result.is_error, Some(true));
    assert_eq!(text(&result), "No Pod default/missing on fake.");

    let (result, card) = chat
        .call("get_object", json!({ "kind": "pods", "name": "web" }))
        .await;
    assert_eq!(card.title, "Read Pod web");
    assert_eq!(card.result, "Failed: Pod needs a namespace");
    assert_eq!(card.tone, CardTone::Danger);
    assert_eq!(result.is_error, Some(true));
}

#[tokio::test]
async fn get_events_counts_the_events_and_names_the_most_frequent_warning() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    for event in [
        event(
            "default",
            "web.1",
            "Pod",
            "web",
            "Warning",
            "BackOff",
            5,
            "2026-11-22T10:00:05Z",
        ),
        event(
            "default",
            "web.2",
            "Pod",
            "web",
            "Warning",
            "BackOff",
            2,
            "2026-11-22T10:00:04Z",
        ),
        event(
            "default",
            "web.3",
            "Pod",
            "web",
            "Warning",
            "FailedMount",
            6,
            "2026-11-22T10:00:03Z",
        ),
        event(
            "default",
            "api.1",
            "Pod",
            "api",
            "Normal",
            "Pulled",
            9,
            "2026-11-22T10:00:02Z",
        ),
        event(
            "default",
            "web.4",
            "Deployment",
            "web",
            "Normal",
            "ScalingReplicaSet",
            1,
            "2026-11-22T10:00:01Z",
        ),
        event(
            "kube-system",
            "dns.1",
            "Pod",
            "dns",
            "Warning",
            "BackOff",
            1,
            "2026-11-22T10:00:00Z",
        ),
    ] {
        fake.upsert("events", event);
    }
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "get_events",
            json!({ "kind": "Pod", "namespace": "default", "name": "web" }),
        )
        .await;
    assert_eq!(card.title, "Read events · Pod web");
    assert_eq!(card.result, "3 events, BackOff 7 times");
    assert_eq!(
        names(&documents(&text(&result))),
        ["web.1", "web.2", "web.3"],
        "newest first"
    );
    assert_eq!(head(&card), ["Type", "Reason", "Object"]);
    assert_eq!(rows(&card)[0], strings(&["Warning", "BackOff", "Pod web"]));

    let (_, card) = chat
        .call(
            "get_events",
            json!({ "kind": "pods", "namespace": "default" }),
        )
        .await;
    assert_eq!(card.title, "Read events · default");
    assert_eq!(card.result, "4 events, BackOff 7 times");

    let (_, card) = chat
        .call("get_events", json!({ "namespace": "default" }))
        .await;
    assert_eq!(card.result, "5 events, BackOff 7 times");

    let (_, card) = chat.call("get_events", json!({})).await;
    assert_eq!(card.title, "Read events · all namespaces");
    assert_eq!(card.result, "6 events, BackOff 8 times");

    let (_, card) = chat
        .call("get_events", json!({ "namespace": "kube-system" }))
        .await;
    assert_eq!(card.result, "1 event, BackOff 1 time");

    assert_eq!(
        chat.refused("get_events", json!({ "name": "web" })).await,
        "get_events needs kind when it names an object."
    );
}

#[tokio::test]
async fn get_logs_reads_the_last_lines_once() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "web");
    fake.add_pod("default", "quiet");
    let lines: Vec<FakeLogLine> = (1..=5)
        .map(|n| {
            FakeLogLine::new(
                &format!("2026-11-22T10:00:0{n}.000000001Z"),
                &format!("line {n}"),
            )
        })
        .collect();
    fake.add_log_lines("default", "web", "main", &lines);
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "get_logs",
            json!({ "namespace": "default", "pod": "web", "tail_lines": 3 }),
        )
        .await;
    assert_eq!(card.title, "Read logs · web · last 3 lines");
    assert_eq!(card.result, "3 lines");
    let expected = "2026-11-22T10:00:03.000000001Z line 3\n\
                    2026-11-22T10:00:04.000000001Z line 4\n\
                    2026-11-22T10:00:05.000000001Z line 5\n";
    assert_eq!(text(&result), expected);
    assert_eq!(
        card.details,
        CardDetails::Text {
            text: expected.trim_end().to_owned()
        }
    );
    let request = fake.log_requests().last().cloned().unwrap();
    assert_eq!(request.get("tailLines").map(String::as_str), Some("3"));
    assert_eq!(request.get("timestamps").map(String::as_str), Some("true"));
    assert!(
        request.get("follow").is_none_or(|follow| follow == "false"),
        "{request:?}"
    );
    assert!(!request.contains_key("container"), "{request:?}");

    let (result, card) = chat
        .call(
            "get_logs",
            json!({
                "namespace": "default",
                "pod": "web",
                "container": "main",
                "previous": true,
                "since_seconds": 60,
            }),
        )
        .await;
    assert_eq!(
        card.title,
        "Read logs · web · main · previous container · last 100 lines"
    );
    assert_eq!(card.result, "5 lines");
    assert_eq!(text(&result).lines().count(), 5);
    let request = fake.log_requests().last().cloned().unwrap();
    assert_eq!(request.get("container").map(String::as_str), Some("main"));
    assert_eq!(request.get("previous").map(String::as_str), Some("true"));
    assert_eq!(request.get("sinceSeconds").map(String::as_str), Some("60"));
    assert_eq!(request.get("tailLines").map(String::as_str), Some("100"));
    assert_eq!(fake.log_requests().len(), 2, "one request per call");

    let (result, card) = chat
        .call(
            "get_logs",
            json!({ "namespace": "default", "pod": "quiet" }),
        )
        .await;
    assert_eq!(card.result, "0 lines");
    assert_eq!(text(&result), "0 lines");
    assert_eq!(card.details, CardDetails::None);
}

#[tokio::test]
async fn pod_logs_text_reads_the_tail_once_with_timestamps() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "web");
    let lines: Vec<FakeLogLine> = (1..=5)
        .map(|n| {
            FakeLogLine::new(
                &format!("2026-11-22T10:00:0{n}.000000001Z"),
                &format!("line {n}"),
            )
        })
        .collect();
    fake.add_log_lines("default", "web", "main", &lines);

    let tail = core
        .pod_logs_text(&id, "default", "web", None, false, 2, None)
        .await
        .unwrap();
    assert_eq!(
        tail,
        [
            "2026-11-22T10:00:04.000000001Z line 4",
            "2026-11-22T10:00:05.000000001Z line 5",
        ]
    );
    assert_eq!(fake.log_requests().len(), 1);

    let error = core
        .pod_logs_text(&id, "a/b", "web", None, false, 2, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(
        fake.log_requests().len(),
        1,
        "a name that is not valid is refused before any request"
    );
}

#[tokio::test]
async fn get_usage_reads_pods_of_a_namespace_and_nodes() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_metrics_api(
        vec![json!({
            "metadata": { "name": "worker" },
            "timestamp": "2026-11-22T10:00:00Z",
            "window": "20s",
            "usage": { "cpu": "1500m", "memory": "2Gi" },
        })],
        vec![
            pod_metrics("default", "web", "250m", "64Mi"),
            pod_metrics("kube-system", "dns", "5m", "32Mi"),
        ],
    );
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call("get_usage", json!({ "of": "pods", "namespace": "default" }))
        .await;
    assert_eq!(card.title, "Read usage · Pods · default");
    assert_eq!(card.result, "1 Pod");
    let items = documents(&text(&result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["namespace"], "default");
    assert_eq!(items[0]["name"], "web");
    let cpu = items[0]["cpuCores"].as_f64().expect("cpuCores is a number");
    assert!((cpu - 0.25).abs() < 1e-9, "{cpu}");
    assert_eq!(rows(&card), [strings(&["default", "web"])]);

    let (result, card) = chat.call("get_usage", json!({ "of": "nodes" })).await;
    assert_eq!(card.title, "Read usage · Nodes");
    assert_eq!(card.result, "1 node");
    assert_eq!(documents(&text(&result))[0]["name"], "worker");
    assert_eq!(head(&card), ["Name"]);

    set_agent(&core, &id, limited_to(&["kube-system"]));
    let (result, card) = chat.call("get_usage", json!({ "of": "pods" })).await;
    assert_eq!(card.title, "Read usage · Pods · all namespaces");
    assert_eq!(card.result, "1 Pod");
    assert_eq!(documents(&text(&result))[0]["name"], "dns");
}

#[tokio::test]
async fn the_helm_tools_list_and_read_releases() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let _helm = fake_helm(&core);
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat.call("list_helm_releases", json!({})).await;
    assert_eq!(card.title, "List Helm releases · all namespaces");
    assert_eq!(card.result, "2 releases");
    let releases = documents(&text(&result));
    let mut listed: Vec<(&str, &str)> = releases
        .iter()
        .map(|release| {
            (
                release["namespace"].as_str().unwrap(),
                release["name"].as_str().unwrap(),
            )
        })
        .collect();
    listed.sort();
    assert_eq!(listed, [("default", "api"), ("shop", "web")]);
    assert_eq!(head(&card), ["Namespace", "Name"]);

    let (result, card) = chat
        .call(
            "get_helm_release",
            json!({ "namespace": "shop", "name": "web" }),
        )
        .await;
    assert_eq!(card.title, "Read Helm release shop/web");
    assert_eq!(card.result, "Revision 2, deployed");
    let shown = text(&result);
    assert!(!shown.contains("c2VjcmV0"), "{shown}");
    assert!(shown.contains("# Secret values are hidden."), "{shown}");
    assert!(shown.contains("greeting: hello"), "{shown}");
    let parts = documents(&shown);
    assert_eq!(parts[0]["name"], "web");
    assert_eq!(parts[0]["status"], "deployed");
    assert!(parts[0].get("manifest").is_none(), "{shown}");
    assert!(matches!(card.details, CardDetails::Text { .. }));

    // A namespace limit keeps only the releases it allows, whatever helm prints.
    set_agent(&core, &id, limited_to(&["default"]));
    let (result, card) = chat.call("list_helm_releases", json!({})).await;
    assert_eq!(card.result, "1 release");
    assert_eq!(documents(&text(&result))[0]["name"], "api");
}

#[tokio::test]
async fn a_forbidden_read_fails_with_forbidden() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "secrets".into(),
            namespace: Some("default".into()),
        }],
        ..FakeKubeConfig::default()
    })
    .await;
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "list_objects",
            json!({ "kind": "secrets", "namespace": "default" }),
        )
        .await;
    assert_eq!(card.title, "List Secrets · default");
    assert_eq!(card.result, "Forbidden");
    assert_eq!(card.tone, CardTone::Danger);
    assert_eq!(result.is_error, Some(true));
    assert!(!text(&result).is_empty());
}

#[tokio::test]
async fn an_unknown_kind_fails_and_says_so() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let mut chat = open(&core, one_cluster(&id)).await;

    let (result, card) = chat
        .call(
            "list_objects",
            json!({ "kind": "Gadget", "namespace": "default" }),
        )
        .await;
    assert_eq!(card.title, "List Gadget · default");
    assert_eq!(card.result, "Failed: Unknown kind Gadget.");
    assert_eq!(card.tone, CardTone::Danger);
    assert_eq!(result.is_error, Some(true));
    assert_eq!(text(&result), "Unknown kind Gadget.");

    let (result, _) = chat
        .call(
            "get_object",
            json!({ "kind": "deploymen", "namespace": "default", "name": "web" }),
        )
        .await;
    assert_eq!(
        text(&result),
        "Unknown kind deploymen. Similar kinds: deployments.apps."
    );
}

#[tokio::test]
async fn a_cluster_that_is_not_connected_asks_for_a_connection() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let mut chat = open(&core, across(&id)).await;
    let note = "ghost is not connected. Ask the person to connect it.";

    let (result, card) = chat
        .call(
            "list_objects",
            json!({ "cluster": "ghost", "kind": "pods" }),
        )
        .await;
    assert_eq!(card.title, "List pods · all namespaces");
    assert_eq!(card.cluster.as_deref(), Some("ghost"));
    assert_eq!(card.result, format!("Failed: {note}"));
    assert_eq!(card.tone, CardTone::Danger);
    assert_eq!(result.is_error, Some(true));
    assert_eq!(text(&result), note);

    let (result, card) = chat
        .call(
            "get_logs",
            json!({ "cluster": "ghost", "namespace": "default", "pod": "web" }),
        )
        .await;
    assert_eq!(card.result, format!("Failed: {note}"));
    assert_eq!(text(&result), note);

    // The connected cluster still answers, under its chip.
    let (_, card) = chat
        .call("list_objects", json!({ "cluster": "fake", "kind": "pods" }))
        .await;
    assert_eq!(card.cluster.as_deref(), Some("fake"));
    assert_eq!(card.result, "0 Pods");

    assert_eq!(
        chat.refused("list_kinds", json!({})).await,
        "Name the cluster with the cluster argument: one of fake, ghost."
    );
    assert_eq!(
        chat.refused("list_kinds", json!({ "cluster": "nowhere" }))
            .await,
        "No cluster named nowhere in this chat. Use one of: fake, ghost."
    );
}

#[tokio::test]
async fn arguments_that_do_not_fit_are_refused_without_a_card() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let mut chat = open(&core, one_cluster(&id)).await;

    let message = chat
        .refused("list_objects", json!({ "namespace": "default" }))
        .await;
    assert!(
        message.starts_with("The arguments of list_objects are not valid: missing field `kind`"),
        "{message}"
    );
    let message = chat.refused("get_usage", json!({ "of": "disks" })).await;
    assert!(
        message.starts_with("The arguments of get_usage are not valid: unknown variant `disks`"),
        "{message}"
    );
}

#[tokio::test]
async fn a_tool_of_another_scope_is_unknown() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let mut chat = open(&core, one_cluster(&id)).await;
    for tool in ["list_clusters", "no_such_tool"] {
        assert_eq!(
            chat.refused(tool, json!({})).await,
            format!("Unknown tool {tool}.")
        );
    }
}
