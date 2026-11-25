//! The agents' tools and change gate against the real `skopos-e2e` kind cluster: reads, a
//! strategic patch that waits for approval, a JSON patch and its dry run, server-side apply as
//! `skopos-agent`, and a command run in a container, through the MCP server a chat serves.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.
#![cfg(unix)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::ConfigMap;
use kube::api::PostParams;
use kube::{Api, Client};
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::{Peer, RoleClient, ServiceExt};
use serde_json::{json, Value};
use skopos_core::agents::approvals::{Approvals, ChangeAnswer, ChangeCard, ChangeState};
use skopos_core::agents::diff::DiffKind;
use skopos_core::agents::mcp::changes::ChatGate;
use skopos_core::agents::mcp::{serve_mcp, ScopeCluster, ToolContext, ToolScope};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::{AgentChanges, ClusterAgentSettings, ClusterSettings};
use skopos_core::resources::{PatchKind, ResourceRef};
use support::{connected_kind, create_pod, in_namespace, wait_running, TEST_IMAGE};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

const CLUSTER: &str = "kind-skopos-e2e";
const WAIT: Duration = Duration::from_secs(60);

struct Chat {
    client: RunningService<RoleClient, ()>,
    cards: mpsc::Receiver<ChangeCard>,
    approvals: Arc<Approvals>,
}

impl Chat {
    async fn start(core: &AppCore, id: &ClusterId) -> Chat {
        let scope = ToolScope {
            clusters: vec![ScopeCluster {
                id: id.clone(),
                name: CLUSTER.to_owned(),
            }],
            global: false,
        };
        let (change_cards, cards) = mpsc::channel(64);
        let approvals = Approvals::new(change_cards);
        let gate = Arc::new(ChatGate {
            core: core.clone(),
            approvals: approvals.clone(),
            scope: scope.clone(),
        });
        let (tool_cards, mut read_cards) = mpsc::channel(64);
        tokio::spawn(async move { while read_cards.recv().await.is_some() {} });
        let context = Arc::new(ToolContext {
            core: core.clone(),
            scope,
            cards: tool_cards,
            gate,
            tabs: skopos_core::agents::tabs::EditorTabs::new(tokio::sync::mpsc::channel(1).0),
        });
        let (server_end, client_end) = tokio::io::duplex(1 << 20);
        tokio::spawn(serve_mcp(Box::new(server_end), context));
        let client = ().serve(client_end).await.unwrap();
        Chat {
            client,
            cards,
            approvals,
        }
    }

    async fn call(&self, tool: &str, args: Value) -> (bool, String) {
        call_with(self.client.peer(), tool, args).await
    }

    fn call_in_background(&self, tool: &str, args: Value) -> JoinHandle<(bool, String)> {
        let peer = self.client.peer().clone();
        let tool = tool.to_owned();
        tokio::spawn(async move { call_with(&peer, &tool, args).await })
    }

    async fn next_card(&mut self) -> ChangeCard {
        tokio::time::timeout(WAIT, self.cards.recv())
            .await
            .expect("no change card came")
            .expect("the card stream closed")
    }
}

async fn call_with(peer: &Peer<RoleClient>, tool: &str, args: Value) -> (bool, String) {
    let Value::Object(args) = args else {
        panic!("the arguments must be an object");
    };
    let result = peer
        .call_tool(CallToolRequestParams::new(tool.to_owned()).with_arguments(args))
        .await
        .unwrap();
    let text = result
        .content
        .iter()
        .filter_map(|block| block.as_text())
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (result.is_error == Some(true), text)
}

async fn kind_client() -> (AppCore, ClusterId, Client, tempfile::TempDir) {
    let (core, id, root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    (core, id, client, root)
}

fn set_agent(core: &AppCore, id: &ClusterId, agent: ClusterAgentSettings) {
    let settings = ClusterSettings {
        agent,
        ..core.cluster_settings_get(id)
    };
    core.cluster_settings_set(id, settings).unwrap();
}

fn deployments() -> ResourceRef {
    ResourceRef {
        group: "apps".into(),
        version: "v1".into(),
        plural: "deployments".into(),
        kind: "Deployment".into(),
        namespaced: true,
    }
}

fn deployment(name: &str, containers: &[&str]) -> Deployment {
    let containers: Vec<Value> = containers
        .iter()
        .map(|container| json!({ "name": container, "image": "registry.k8s.io/pause:3.10" }))
        .collect();
    serde_json::from_value(json!({
        "metadata": { "name": name },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": name } },
            "template": {
                "metadata": { "labels": { "app": name } },
                "spec": { "containers": containers },
            },
        },
    }))
    .unwrap()
}

async fn create_deployment(client: &Client, namespace: &str, object: Deployment) {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    api.create(&PostParams::default(), &object).await.unwrap();
}

async fn read_deployment(core: &AppCore, id: &ClusterId, namespace: &str) -> Value {
    core.resource_get(id, &deployments(), Some(namespace), "web")
        .await
        .unwrap()
}

fn containers(object: &Value) -> Vec<Value> {
    object
        .pointer("/spec/template/spec/containers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn env_of(object: &Value, container: &str) -> Value {
    containers(object)
        .into_iter()
        .find(|entry| entry["name"] == container)
        .and_then(|entry| entry.get("env").cloned())
        .unwrap_or(Value::Null)
}

async fn shell_pod(client: &Client, namespace: &str) {
    create_pod(
        client,
        namespace,
        json!({
            "metadata": { "name": "box" },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [{ "name": "main", "image": TEST_IMAGE, "args": ["pause"] }],
            },
        }),
    )
    .await;
    wait_running(client, namespace, "box").await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn the_read_tools_answer_from_the_cluster() {
    const NAMESPACE: &str = "skopos-test-agents-read";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_deployment(&client, NAMESPACE, deployment("web", &["main"])).await;
        let chat = Chat::start(&core, &id).await;
        let (failed, text) = chat
            .call(
                "list_objects",
                json!({ "kind": "Deployment", "namespace": NAMESPACE }),
            )
            .await;
        assert!(!failed, "{text}");
        assert!(text.contains("name: web"), "{text}");
        let (failed, text) = chat
            .call(
                "get_object",
                json!({ "kind": "deploy", "namespace": NAMESPACE, "name": "web" }),
            )
            .await;
        assert!(!failed, "{text}");
        assert!(text.contains("kind: Deployment"), "{text}");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_strategic_patch_waits_for_approval_and_merges_containers_by_name() {
    const NAMESPACE: &str = "skopos-test-agents-patch";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_deployment(&client, NAMESPACE, deployment("web", &["main", "side"])).await;
        let mut chat = Chat::start(&core, &id).await;
        let patch = json!({ "spec": { "template": { "spec": { "containers": [
            { "name": "main", "env": [{ "name": "MODE", "value": "fast" }] },
        ] } } } });
        let call = chat.call_in_background(
            "patch_object",
            json!({
                "kind": "Deployment", "namespace": NAMESPACE, "name": "web",
                "patch": patch, "patch_type": "strategic", "summary": "Set MODE=fast on main",
            }),
        );
        let waiting = chat.next_card().await;
        assert_eq!(waiting.state, ChangeState::Waiting);
        assert_eq!(waiting.title, format!("Change Deployment {NAMESPACE}/web"));
        assert!(
            waiting
                .diff
                .iter()
                .any(|line| line.kind == DiffKind::Added && line.text.contains("MODE")),
            "{:?}",
            waiting.diff
        );
        let live = read_deployment(&core, &id, NAMESPACE).await;
        assert_eq!(
            env_of(&live, "main"),
            Value::Null,
            "nothing is applied before an answer"
        );

        chat.approvals
            .answer(&waiting.id, ChangeAnswer::Approve)
            .unwrap();
        let (failed, text) = call.await.unwrap();
        assert!(!failed, "{text}");
        assert!(text.starts_with("Applied.\nresourceVersion: "), "{text}");
        let approved = chat.next_card().await;
        assert!(
            matches!(
                approved.state,
                ChangeState::Approved {
                    standing: false,
                    ..
                }
            ),
            "{:?}",
            approved.state
        );
        assert!(approved.rollout.is_some());
        let live = read_deployment(&core, &id, NAMESPACE).await;
        assert_eq!(
            env_of(&live, "main"),
            json!([{ "name": "MODE", "value": "fast" }])
        );
        let names: Vec<Value> = containers(&live)
            .into_iter()
            .map(|entry| entry["name"].clone())
            .collect();
        assert_eq!(names, [json!("main"), json!("side")]);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_json_patch_dry_run_answers_with_the_change_and_stores_nothing() {
    const NAMESPACE: &str = "skopos-test-agents-json";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_deployment(&client, NAMESPACE, deployment("web", &["main"])).await;
        let patch = json!([{ "op": "replace", "path": "/spec/replicas", "value": 3 }]);
        let dry = core
            .resource_patch(
                &id,
                &deployments(),
                Some(NAMESPACE),
                "web",
                &patch,
                PatchKind::Json,
                true,
            )
            .await
            .unwrap();
        assert_eq!(dry["spec"]["replicas"], 3);
        assert_eq!(
            read_deployment(&core, &id, NAMESPACE).await["spec"]["replicas"],
            1
        );
        let stored = core
            .resource_patch(
                &id,
                &deployments(),
                Some(NAMESPACE),
                "web",
                &patch,
                PatchKind::Json,
                false,
            )
            .await
            .unwrap();
        assert_eq!(stored["spec"]["replicas"], 3);
        assert_eq!(
            read_deployment(&core, &id, NAMESPACE).await["spec"]["replicas"],
            3
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn apply_through_the_gate_uses_server_side_apply_as_skopos_agent() {
    const NAMESPACE: &str = "skopos-test-agents-apply";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        set_agent(
            &core,
            &id,
            ClusterAgentSettings {
                changes: AgentChanges::DontAsk,
                ..ClusterAgentSettings::default()
            },
        );
        let mut chat = Chat::start(&core, &id).await;
        let yaml = format!(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: made\n  namespace: {NAMESPACE}\ndata:\n  a: one\n"
        );
        let (failed, text) = chat
            .call("apply_object", json!({ "yaml": yaml, "summary": "Add made" }))
            .await;
        assert!(!failed, "{text}");
        let created = chat.next_card().await;
        assert_eq!(created.title, format!("Create ConfigMap {NAMESPACE}/made"));
        assert_eq!(
            created.state,
            ChangeState::AppliedWithoutAsking { standing: false }
        );
        let configmaps: Api<ConfigMap> = Api::namespaced(client.clone(), NAMESPACE);
        let made = configmaps.get("made").await.unwrap();
        let managers: Vec<String> = made
            .metadata
            .managed_fields
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entry| entry.manager)
            .collect();
        assert!(managers.contains(&"skopos-agent".to_owned()), "{managers:?}");

        let changed = yaml.replace("a: one", "a: two");
        let (failed, text) = chat
            .call("apply_object", json!({ "yaml": changed, "summary": "Set a" }))
            .await;
        assert!(!failed, "{text}");
        let card = chat.next_card().await;
        assert_eq!(card.title, format!("Change ConfigMap {NAMESPACE}/made"));
        assert!(
            card.diff
                .iter()
                .any(|line| line.kind == DiffKind::Removed && line.text == "  a: one"),
            "{:?}",
            card.diff
        );
        assert!(
            card.diff
                .iter()
                .any(|line| line.kind == DiffKind::Added && line.text == "  a: two"),
            "{:?}",
            card.diff
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn exec_through_the_gate_returns_the_exit_code_and_what_the_command_printed() {
    const NAMESPACE: &str = "skopos-test-agents-exec";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        shell_pod(&client, NAMESPACE).await;
        set_agent(
            &core,
            &id,
            ClusterAgentSettings {
                changes: AgentChanges::DontAsk,
                exec: true,
                ..ClusterAgentSettings::default()
            },
        );
        let mut chat = Chat::start(&core, &id).await;
        let (failed, text) = chat
            .call(
                "exec",
                json!({
                    "namespace": NAMESPACE, "pod": "box",
                    "command": ["sh", "-c", "echo out; echo err >&2; exit 3"],
                    "summary": "Print two lines",
                }),
            )
            .await;
        assert!(!failed, "{text}");
        assert!(text.starts_with("Applied.\nExit code 3\n\n"), "{text}");
        assert!(text.contains("out") && text.contains("err"), "{text}");
        let done = chat.next_card().await;
        assert_eq!(done.title, format!("Run a command in Pod {NAMESPACE}/box"));
        assert_eq!(done.result.as_deref(), Some("Exit code 3"));
        assert!(
            done.output
                .as_deref()
                .is_some_and(|output| output.contains("out")),
            "{:?}",
            done.output
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_one_shot_command_runs_to_its_end_or_to_its_time_limit() {
    const NAMESPACE: &str = "skopos-test-agents-once";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        shell_pod(&client, NAMESPACE).await;
        let printed = core
            .pod_exec_once(
                &id,
                NAMESPACE,
                "box",
                None,
                &["sh".to_owned(), "-c".to_owned(), "printf ok".to_owned()],
                Duration::from_secs(30),
            )
            .await
            .unwrap();
        assert_eq!(printed.exit_code, Some(0));
        assert_eq!(printed.output, "ok");
        let error = core
            .pod_exec_once(
                &id,
                NAMESPACE,
                "box",
                None,
                &["sleep".to_owned(), "30".to_owned()],
                Duration::from_secs(2),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(
            error.message,
            "The command did not finish within 2 seconds."
        );
    })
    .await;
}
