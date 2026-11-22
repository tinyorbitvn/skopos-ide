//! The agents' change tools and their gate against the fake API server (spec §4.4, §4.5, §6.3,
//! §6.4): the one-object writes they use, then the tools through an in-process MCP client.
//! Agent settings are refused on Windows, so this file runs on Unix. Every kubeconfig lives in
//! a temp `<home>/.kube`; `KUBECONFIG` is never read.
#![cfg(unix)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::{Peer, RoleClient, ServiceExt};
use serde_json::{json, Value};
use skopos_core::agents::approvals::{
    Approvals, ChangeAnswer, ChangeCard, ChangeState, RolloutTarget,
};
use skopos_core::agents::diff::{DiffKind, DiffLine};
use skopos_core::agents::mcp::changes::ChatGate;
use skopos_core::agents::mcp::{serve_mcp, ScopeCluster, ToolContext, ToolScope};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::{AgentChanges, ClusterAgentSettings, ClusterSettings};
use skopos_core::resources::{PatchKind, ResourceRef};
use skopos_fakekube::{FakeKube, FakeKubeConfig};
use support::connected_fake;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

const CONFIGMAP_C: &str = "/api/v1/namespaces/default/configmaps/c";
const CONFIGMAP_MADE: &str = "/api/v1/namespaces/default/configmaps/made";
const MADE: &str = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: made\ndata:\n  a: one\n";
const TWO_DOCUMENTS: &str = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n";

fn configmaps() -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "configmaps".into(),
        kind: "ConfigMap".into(),
        namespaced: true,
    }
}

fn configmap(namespace: &str, name: &str, value: &str) -> Value {
    json!({ "metadata": { "name": name, "namespace": namespace }, "data": { "a": value } })
}

async fn value_of(core: &AppCore, id: &ClusterId, namespace: &str, name: &str) -> String {
    let object = core
        .resource_get(id, &configmaps(), Some(namespace), name)
        .await
        .unwrap();
    object["data"]["a"].as_str().unwrap().to_owned()
}

/// The `dryRun` parameter of each PATCH that reached `path`, oldest first.
fn dry_runs(fake: &FakeKube, path: &str) -> Vec<Option<String>> {
    fake.writes("PATCH", path)
        .into_iter()
        .map(|write| write.query.get("dryRun").cloned())
        .collect()
}

fn field_managers(fake: &FakeKube, path: &str) -> Vec<Option<String>> {
    fake.writes("PATCH", path)
        .into_iter()
        .map(|write| write.query.get("fieldManager").cloned())
        .collect()
}

#[tokio::test]
async fn a_dry_run_patch_answers_with_the_result_and_changes_nothing() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let patch = json!({ "data": { "a": "two" } });
    let dry = core
        .resource_patch(
            &id,
            &configmaps(),
            Some("default"),
            "c",
            &patch,
            PatchKind::Merge,
            true,
        )
        .await
        .unwrap();
    assert_eq!(dry["data"]["a"], "two");
    assert_eq!(value_of(&core, &id, "default", "c").await, "one");
    let stored = core
        .resource_patch(
            &id,
            &configmaps(),
            Some("default"),
            "c",
            &patch,
            PatchKind::Merge,
            false,
        )
        .await
        .unwrap();
    assert_eq!(stored["data"]["a"], "two");
    assert_eq!(value_of(&core, &id, "default", "c").await, "two");
    assert_eq!(dry_runs(&fake, CONFIGMAP_C), [Some("All".to_owned()), None]);
    assert_eq!(
        field_managers(&fake, CONFIGMAP_C),
        [
            Some("skopos-agent".to_owned()),
            Some("skopos-agent".to_owned())
        ]
    );
}

/// The fake answers JSON patches with 415 (R7), which shows they do not go out as a merge
/// patch; kind checks what they do.
#[tokio::test]
async fn a_json_patch_is_sent_as_its_list_of_operations() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let patch = json!([{ "op": "replace", "path": "/data/a", "value": "two" }]);
    let error = core
        .resource_patch(
            &id,
            &configmaps(),
            Some("default"),
            "c",
            &patch,
            PatchKind::Json,
            true,
        )
        .await
        .unwrap_err();
    assert_eq!(error.details.as_deref(), Some("HTTP 415"));
    assert_eq!(fake.writes("PATCH", CONFIGMAP_C)[0].body, patch);
}

#[tokio::test]
async fn a_patch_of_the_wrong_shape_is_refused_before_it_is_sent() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let list = json!([{ "op": "remove", "path": "/data/a" }]);
    let object = json!({ "data": { "a": "two" } });
    for (patch, kind) in [
        (&list, PatchKind::Merge),
        (&list, PatchKind::Strategic),
        (&object, PatchKind::Json),
    ] {
        let error = core
            .resource_patch(&id, &configmaps(), Some("default"), "c", patch, kind, true)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{kind:?}");
    }
    assert!(fake.writes("PATCH", CONFIGMAP_C).is_empty());
}

#[tokio::test]
async fn apply_one_applies_a_single_document_as_skopos_agent() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (resource, namespace, name, dry) = core.resource_apply_one(&id, MADE, true).await.unwrap();
    assert_eq!(resource, configmaps());
    assert_eq!(namespace.as_deref(), Some("default"));
    assert_eq!(name, "made");
    assert_eq!(dry["data"]["a"], "one");
    let missing = core
        .resource_get(&id, &configmaps(), Some("default"), "made")
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    let (_, _, _, stored) = core.resource_apply_one(&id, MADE, false).await.unwrap();
    assert_eq!(stored["data"]["a"], "one");
    assert_eq!(value_of(&core, &id, "default", "made").await, "one");
    assert_eq!(
        dry_runs(&fake, CONFIGMAP_MADE),
        [Some("All".to_owned()), None]
    );
    assert_eq!(
        field_managers(&fake, CONFIGMAP_MADE),
        [
            Some("skopos-agent".to_owned()),
            Some("skopos-agent".to_owned())
        ]
    );
}

#[tokio::test]
async fn apply_one_takes_exactly_one_document() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    for yaml in ["", "# nothing\n", TWO_DOCUMENTS] {
        let error = core.resource_apply_one(&id, yaml, true).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{yaml:?}");
        assert_eq!(error.message, "Apply one object per call.", "{yaml:?}");
    }
    let unquoted = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: made\n  namespace: 123\n";
    let error = core
        .resource_apply_one(&id, unquoted, true)
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "metadata.namespace must be a string; write it in quotes"
    );
}

const CLUSTER: &str = "fake";
const WAIT: Duration = Duration::from_secs(10);
const CHANGE_TOOLS: [&str; 6] = [
    "apply_object",
    "patch_object",
    "scale",
    "restart",
    "delete_object",
    "exec",
];
const SECRET_S: &str = "/api/v1/namespaces/default/secrets/s";
const DEPLOYMENT_WEB: &str = "/apis/apps/v1/namespaces/default/deployments/web";
const DENIED: &str = "The person denied this change.";
const READ_ONLY: &str = "Changes to fake are read only for agents.";

/// A chat's tools on the fake cluster: the gate of a real chat, over an in-process MCP client.
struct Chat {
    client: RunningService<RoleClient, ()>,
    cards: mpsc::Receiver<ChangeCard>,
    approvals: Arc<Approvals>,
}

impl Chat {
    async fn start(core: &AppCore, id: &ClusterId, global: bool) -> Chat {
        let scope = ToolScope {
            clusters: vec![ScopeCluster {
                id: id.clone(),
                name: CLUSTER.to_owned(),
            }],
            global,
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

    /// Whether the call failed, and the text it answered with.
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

    fn no_more_cards(&mut self) -> bool {
        self.cards.try_recv().is_err()
    }

    async fn tool_names(&self) -> Vec<String> {
        self.client
            .list_all_tools()
            .await
            .unwrap()
            .into_iter()
            .map(|tool| tool.name.into_owned())
            .collect()
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

fn listed(names: &[String], tool: &str) -> bool {
    names.contains(&tool.to_owned())
}

fn set_changes(core: &AppCore, id: &ClusterId, changes: AgentChanges) {
    core.cluster_agent_changes_set(id, changes).unwrap();
}

fn set_agent(core: &AppCore, id: &ClusterId, agent: ClusterAgentSettings) {
    let settings = ClusterSettings {
        agent,
        ..core.cluster_settings_get(id)
    };
    core.cluster_settings_set(id, settings).unwrap();
}

fn patch_args(namespace: &str, name: &str, value: &str) -> Value {
    json!({
        "kind": "ConfigMap", "namespace": namespace, "name": name,
        "patch": { "data": { "a": value } }, "patch_type": "merge",
        "summary": format!("Set a to {value}"),
    })
}

fn delete_args(kind: &str, namespace: Option<&str>, name: &str) -> Value {
    json!({ "kind": kind, "namespace": namespace, "name": name, "summary": format!("Remove {name}") })
}

fn exec_args(namespace: &str) -> Value {
    json!({ "namespace": namespace, "pod": "p", "command": ["ls", "/"], "summary": "List the root folder" })
}

/// The same arguments with the `cluster` a global chat needs.
fn in_global(mut args: Value) -> Value {
    args["cluster"] = json!(CLUSTER);
    args
}

fn deployment(name: &str, replicas: i32) -> Value {
    json!({ "metadata": { "name": name, "namespace": "default" }, "spec": { "replicas": replicas } })
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

fn added(text: &str) -> DiffLine {
    DiffLine {
        kind: DiffKind::Added,
        text: text.to_owned(),
    }
}

fn removed(text: &str) -> DiffLine {
    DiffLine {
        kind: DiffKind::Removed,
        text: text.to_owned(),
    }
}

/// `HH:MM`.
fn is_clock_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 5 && bytes[2] == b':' && [0, 1, 3, 4].iter().all(|&i| bytes[i].is_ascii_digit())
}

#[tokio::test]
async fn nothing_is_applied_before_an_answer_and_an_approved_change_says_when() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let mut chat = Chat::start(&core, &id, false).await;
    let call = chat.call_in_background("patch_object", patch_args("default", "c", "two"));
    let waiting = chat.next_card().await;
    assert_eq!(waiting.state, ChangeState::Waiting);
    assert_eq!(waiting.title, "Change ConfigMap default/c");
    assert_eq!(waiting.cluster, CLUSTER);
    assert_eq!(waiting.summary, "Set a to two");
    assert!(
        waiting.diff.contains(&removed("  a: one")),
        "{:?}",
        waiting.diff
    );
    assert!(
        waiting.diff.contains(&added("  a: two")),
        "{:?}",
        waiting.diff
    );
    assert_eq!(value_of(&core, &id, "default", "c").await, "one");
    assert_eq!(dry_runs(&fake, CONFIGMAP_C), [Some("All".to_owned())]);

    chat.approvals
        .answer(&waiting.id, ChangeAnswer::Approve)
        .unwrap();
    let (failed, text) = call.await.unwrap();
    assert!(!failed, "{text}");
    assert!(text.starts_with("Applied.\nresourceVersion: "), "{text}");
    let approved = chat.next_card().await;
    assert_eq!(approved.id, waiting.id);
    let ChangeState::Approved { at, standing } = &approved.state else {
        panic!("{:?}", approved.state);
    };
    assert!(is_clock_time(at), "{at}");
    assert!(!*standing);
    assert_eq!(approved.result, None);
    assert_eq!(value_of(&core, &id, "default", "c").await, "two");
    assert!(!chat.approvals.standing(&id));
}

#[tokio::test]
async fn deny_returns_the_person_denied_this_change_and_applies_nothing() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let mut chat = Chat::start(&core, &id, false).await;
    let call = chat.call_in_background("patch_object", patch_args("default", "c", "two"));
    let waiting = chat.next_card().await;
    chat.approvals
        .answer(&waiting.id, ChangeAnswer::Deny)
        .unwrap();
    assert_eq!(call.await.unwrap(), (true, DENIED.to_owned()));
    let denied = chat.next_card().await;
    assert_eq!(denied.id, waiting.id);
    assert_eq!(denied.state, ChangeState::Denied);
    assert_eq!(value_of(&core, &id, "default", "c").await, "one");
    assert_eq!(dry_runs(&fake, CONFIGMAP_C), [Some("All".to_owned())]);
}

#[tokio::test]
async fn stopping_the_chat_answers_a_waiting_change_as_stopped() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let mut chat = Chat::start(&core, &id, false).await;
    let call = chat.call_in_background("patch_object", patch_args("default", "c", "two"));
    let waiting = chat.next_card().await;
    assert_eq!(waiting.state, ChangeState::Waiting);

    chat.approvals.stop_all();
    assert_eq!(
        call.await.unwrap(),
        (true, "The chat was stopped.".to_owned())
    );
    let stopped = chat.next_card().await;
    assert_eq!(stopped.id, waiting.id);
    assert_eq!(stopped.state, ChangeState::Stopped);
    assert!(chat.no_more_cards());
    assert_eq!(value_of(&core, &id, "default", "c").await, "one");
    assert_eq!(dry_runs(&fake, CONFIGMAP_C), [Some("All".to_owned())]);
}

#[tokio::test]
async fn a_setting_changed_during_a_chat_applies_to_the_next_call() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let mut chat = Chat::start(&core, &id, false).await;
    assert!(listed(&chat.tool_names().await, "patch_object"));

    set_changes(&core, &id, AgentChanges::ReadOnly);
    assert_eq!(
        chat.call("patch_object", patch_args("default", "c", "two"))
            .await,
        (true, READ_ONLY.to_owned())
    );
    assert!(
        fake.writes("PATCH", CONFIGMAP_C).is_empty(),
        "not even a dry run"
    );
    assert!(chat.no_more_cards());
    let names = chat.tool_names().await;
    assert!(
        CHANGE_TOOLS.iter().all(|tool| !listed(&names, tool)),
        "{names:?}"
    );

    set_changes(&core, &id, AgentChanges::DontAsk);
    let (failed, text) = chat
        .call("patch_object", patch_args("default", "c", "two"))
        .await;
    assert!(!failed, "{text}");
    assert_eq!(value_of(&core, &id, "default", "c").await, "two");
}

#[tokio::test]
async fn read_only_lists_no_change_tool_in_a_per_cluster_chat() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            changes: AgentChanges::ReadOnly,
            exec: true,
            ..ClusterAgentSettings::default()
        },
    );
    let chat = Chat::start(&core, &id, false).await;
    let names = chat.tool_names().await;
    assert!(listed(&names, "get_object"), "{names:?}");
    assert!(
        CHANGE_TOOLS.iter().all(|tool| !listed(&names, tool)),
        "{names:?}"
    );
    assert_eq!(
        chat.call(
            "delete_object",
            delete_args("ConfigMap", Some("default"), "c")
        )
        .await,
        (true, READ_ONLY.to_owned())
    );
    assert!(fake.writes("DELETE", CONFIGMAP_C).is_empty());
}

#[tokio::test]
async fn read_only_refuses_every_change_in_a_global_chat() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    fake.add_pod("default", "p");
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            changes: AgentChanges::ReadOnly,
            exec: true,
            ..ClusterAgentSettings::default()
        },
    );
    let mut chat = Chat::start(&core, &id, true).await;
    let names = chat.tool_names().await;
    for tool in &CHANGE_TOOLS[..5] {
        assert!(listed(&names, tool), "{tool}: {names:?}");
    }
    assert!(
        !listed(&names, "exec"),
        "a Read only cluster lets no command run"
    );
    for (tool, args) in [
        ("patch_object", patch_args("default", "c", "two")),
        (
            "delete_object",
            delete_args("ConfigMap", Some("default"), "c"),
        ),
        ("exec", exec_args("default")),
    ] {
        assert_eq!(
            chat.call(tool, in_global(args)).await,
            (true, READ_ONLY.to_owned()),
            "{tool}"
        );
    }
    assert!(chat.no_more_cards());
    assert!(fake.writes("PATCH", CONFIGMAP_C).is_empty());
    assert!(fake.writes("DELETE", CONFIGMAP_C).is_empty());
}

#[tokio::test]
async fn a_global_chat_change_names_its_cluster() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, true).await;
    let (failed, _) = chat
        .call("patch_object", patch_args("default", "c", "two"))
        .await;
    assert!(failed, "a global chat's change names its cluster");
    assert!(chat.no_more_cards());
    let (failed, text) = chat
        .call("patch_object", in_global(patch_args("default", "c", "two")))
        .await;
    assert!(!failed, "{text}");
    assert_eq!(chat.next_card().await.cluster, CLUSTER);
    assert_eq!(value_of(&core, &id, "default", "c").await, "two");
}

#[tokio::test]
async fn dont_ask_applies_at_once_with_a_done_card() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    let (failed, text) = chat
        .call("patch_object", patch_args("default", "c", "two"))
        .await;
    assert!(!failed, "{text}");
    assert!(text.starts_with("Applied.\nresourceVersion: "), "{text}");
    let done = chat.next_card().await;
    assert_eq!(
        done.state,
        ChangeState::AppliedWithoutAsking { standing: false }
    );
    assert_eq!(done.title, "Change ConfigMap default/c");
    assert!(done.diff.contains(&added("  a: two")), "{:?}", done.diff);
    assert_eq!(done.result, None);
    assert_eq!(done.rollout, None);
    assert!(chat.no_more_cards(), "one card per change");
    assert_eq!(value_of(&core, &id, "default", "c").await, "two");
    assert_eq!(dry_runs(&fake, CONFIGMAP_C), [Some("All".to_owned()), None]);
}

#[tokio::test]
async fn a_standing_approval_covers_later_changes_of_that_chat_and_cluster_until_undone() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    fake.upsert("configmaps", configmap("default", "gone", "one"));
    let mut chat = Chat::start(&core, &id, false).await;
    let first = chat.call_in_background("patch_object", patch_args("default", "c", "two"));
    let waiting = chat.next_card().await;
    chat.approvals
        .answer(&waiting.id, ChangeAnswer::ApproveForChat)
        .unwrap();
    assert!(!first.await.unwrap().0);
    let approved = chat.next_card().await;
    assert!(
        matches!(approved.state, ChangeState::Approved { standing: true, .. }),
        "{:?}",
        approved.state
    );
    assert!(chat.approvals.standing(&id));

    let (failed, text) = chat
        .call("patch_object", patch_args("default", "c", "three"))
        .await;
    assert!(!failed, "{text}");
    assert_eq!(
        chat.next_card().await.state,
        ChangeState::AppliedWithoutAsking { standing: true }
    );
    let (failed, text) = chat
        .call(
            "delete_object",
            delete_args("ConfigMap", Some("default"), "gone"),
        )
        .await;
    assert!(!failed, "every change tool: {text}");
    assert_eq!(
        chat.next_card().await.state,
        ChangeState::AppliedWithoutAsking { standing: true }
    );

    let mut other = Chat::start(&core, &id, false).await;
    let elsewhere = other.call_in_background("patch_object", patch_args("default", "c", "four"));
    let asked = other.next_card().await;
    assert_eq!(asked.state, ChangeState::Waiting, "another chat asks");
    other
        .approvals
        .answer(&asked.id, ChangeAnswer::Deny)
        .unwrap();
    assert_eq!(elsewhere.await.unwrap(), (true, DENIED.to_owned()));

    chat.approvals.undo_standing(&id);
    let again = chat.call_in_background("patch_object", patch_args("default", "c", "five"));
    let asked = chat.next_card().await;
    assert_eq!(asked.state, ChangeState::Waiting, "Undo ends the approval");
    chat.approvals
        .answer(&asked.id, ChangeAnswer::Deny)
        .unwrap();
    assert!(again.await.unwrap().0);
    assert_eq!(value_of(&core, &id, "default", "c").await, "three");
}

#[tokio::test]
async fn hidden_secret_values_refuse_secret_changes() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert(
        "secrets",
        json!({ "metadata": { "name": "s", "namespace": "default" }, "data": { "k": "dg==" } }),
    );
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    let refused = (
        true,
        "Secret values are hidden from agents on fake, so they can't change Secrets.".to_owned(),
    );
    let patch = json!({
        "kind": "Secret", "namespace": "default", "name": "s",
        "patch": { "stringData": { "k": "w" } }, "patch_type": "merge", "summary": "Set k",
    });
    assert_eq!(chat.call("patch_object", patch.clone()).await, refused);
    let yaml = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: default\nstringData:\n  k: w\n";
    assert_eq!(
        chat.call("apply_object", json!({ "yaml": yaml, "summary": "Set k" }))
            .await,
        refused
    );
    assert_eq!(
        chat.call(
            "delete_object",
            delete_args("secrets", Some("default"), "s")
        )
        .await,
        refused
    );
    assert!(chat.no_more_cards());
    assert!(fake.writes("PATCH", SECRET_S).is_empty());
    assert!(fake.writes("DELETE", SECRET_S).is_empty());

    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            changes: AgentChanges::DontAsk,
            secret_values: true,
            ..ClusterAgentSettings::default()
        },
    );
    let (failed, text) = chat.call("patch_object", patch).await;
    assert!(!failed, "{text}");
}

const POD_READER: &str = "/api/v1/namespaces/default/pods/reader";
const READER: &str = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: reader\n  namespace: default\nspec:\n  containers:\n  - name: main\n    image: busybox\n    env:\n    - name: DB\n      valueFrom:\n        secretKeyRef:\n          name: db\n          key: url\n  volumes:\n  - name: tls\n    secret:\n      secretName: tls\n";

fn reads_db(command: Option<&str>) -> Value {
    let mut container = json!({
        "name": "main", "image": "busybox",
        "env": [{ "name": "DB", "valueFrom": { "secretKeyRef": { "name": "db", "key": "url" } } }],
    });
    if let Some(command) = command {
        container["command"] = json!([command]);
    }
    json!({ "containers": [container] })
}

/// A patch of Deployment `web` that runs `command`, which can print the Secret it reads.
fn print_db_args(command: &str) -> Value {
    json!({
        "kind": "Deployment", "namespace": "default", "name": "web",
        "patch": { "spec": { "template": { "spec": reads_db(Some(command)) } } },
        "patch_type": "merge", "summary": "Print the environment",
    })
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| (*name).to_owned()).collect()
}

#[tokio::test]
async fn hidden_secret_values_always_ask_for_a_change_that_lets_a_workload_read_a_secret() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    fake.upsert(
        "deployments",
        json!({
            "metadata": { "name": "web", "namespace": "default" },
            "spec": { "replicas": 1, "template": { "spec": reads_db(None) } },
        }),
    );
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;

    let call = chat.call_in_background(
        "apply_object",
        json!({ "yaml": READER, "summary": "Add reader" }),
    );
    let waiting = chat.next_card().await;
    assert_eq!(waiting.state, ChangeState::Waiting, "Don't ask still asks");
    assert_eq!(waiting.title, "Create Pod default/reader");
    assert_eq!(waiting.secrets, names(&["db", "tls"]));
    assert_eq!(dry_runs(&fake, POD_READER), [Some("All".to_owned())]);
    chat.approvals
        .answer(&waiting.id, ChangeAnswer::Approve)
        .unwrap();
    assert!(!call.await.unwrap().0);
    assert!(matches!(
        chat.next_card().await.state,
        ChangeState::Approved {
            standing: false,
            ..
        }
    ));

    let (failed, text) = chat
        .call("patch_object", patch_args("default", "c", "two"))
        .await;
    assert!(!failed, "{text}");
    let plain = chat.next_card().await;
    assert_eq!(
        plain.state,
        ChangeState::AppliedWithoutAsking { standing: false }
    );
    assert!(plain.secrets.is_empty());

    let call = chat.call_in_background("patch_object", print_db_args("env"));
    let waiting = chat.next_card().await;
    assert_eq!(
        waiting.state,
        ChangeState::Waiting,
        "a change to a workload that already reads a Secret asks too"
    );
    assert_eq!(waiting.secrets, names(&["db"]));
    chat.approvals
        .answer(&waiting.id, ChangeAnswer::ApproveForChat)
        .unwrap();
    assert!(!call.await.unwrap().0);
    chat.next_card().await;
    assert!(chat.approvals.standing(&id));

    let call = chat.call_in_background("patch_object", print_db_args("printenv"));
    let waiting = chat.next_card().await;
    assert_eq!(
        waiting.state,
        ChangeState::Waiting,
        "a standing approval doesn't cover it"
    );
    chat.approvals
        .answer(&waiting.id, ChangeAnswer::Deny)
        .unwrap();
    assert_eq!(call.await.unwrap(), (true, DENIED.to_owned()));
    assert_eq!(chat.next_card().await.state, ChangeState::Denied);

    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            changes: AgentChanges::DontAsk,
            secret_values: true,
            ..ClusterAgentSettings::default()
        },
    );
    let (failed, text) = chat.call("patch_object", print_db_args("set")).await;
    assert!(!failed, "{text}");
    let done = chat.next_card().await;
    assert_eq!(
        done.state,
        ChangeState::AppliedWithoutAsking { standing: false },
        "readable Secret values need no question"
    );
    assert!(done.secrets.is_empty());
}

#[tokio::test]
async fn hidden_secret_values_always_ask_before_a_command_in_a_pod_that_reads_a_secret() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "p", "namespace": "default" },
            "spec": reads_db(None),
            "status": { "phase": "Running" },
        }),
    );
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            changes: AgentChanges::DontAsk,
            exec: true,
            ..ClusterAgentSettings::default()
        },
    );
    let mut chat = Chat::start(&core, &id, false).await;
    let call = chat.call_in_background("exec", exec_args("default"));
    let waiting = chat.next_card().await;
    assert_eq!(waiting.state, ChangeState::Waiting);
    assert_eq!(waiting.title, "Run a command in Pod default/p");
    assert_eq!(waiting.secrets, names(&["db"]));
    chat.approvals
        .answer(&waiting.id, ChangeAnswer::Deny)
        .unwrap();
    assert_eq!(call.await.unwrap(), (true, DENIED.to_owned()));
}

#[tokio::test]
async fn a_namespace_limit_refuses_changes_outside_it_and_to_cluster_scoped_objects() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    fake.upsert("configmaps", configmap("payments", "c", "one"));
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            changes: AgentChanges::DontAsk,
            namespaces: Some(vec!["payments".to_owned(), "ingest".to_owned()]),
            ..ClusterAgentSettings::default()
        },
    );
    let mut chat = Chat::start(&core, &id, false).await;
    let limit = (
        true,
        "fake limits agents to these namespaces: ingest, payments.".to_owned(),
    );
    assert_eq!(
        chat.call("patch_object", patch_args("default", "c", "two"))
            .await,
        limit
    );
    assert_eq!(
        chat.call("delete_object", delete_args("Namespace", None, "default"))
            .await,
        limit
    );
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: made\n";
    assert_eq!(
        chat.call(
            "apply_object",
            json!({ "yaml": yaml, "summary": "Add made to default" })
        )
        .await,
        limit,
        "without a namespace the object would go to default"
    );
    assert!(chat.no_more_cards());
    assert!(fake.writes("PATCH", CONFIGMAP_C).is_empty());
    assert!(fake
        .writes("DELETE", "/api/v1/namespaces/default")
        .is_empty());

    let (failed, text) = chat
        .call("patch_object", patch_args("payments", "c", "two"))
        .await;
    assert!(!failed, "{text}");
    assert_eq!(value_of(&core, &id, "payments", "c").await, "two");
}

#[tokio::test]
async fn exec_is_listed_only_where_allowed_and_refused_elsewhere() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    assert!(!listed(&chat.tool_names().await, "exec"));
    assert_eq!(
        chat.call("exec", exec_args("default")).await,
        (
            true,
            "fake doesn't let agents run commands in containers.".to_owned()
        )
    );
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            changes: AgentChanges::DontAsk,
            exec: true,
            namespaces: Some(vec!["payments".to_owned()]),
            ..ClusterAgentSettings::default()
        },
    );
    assert!(listed(&chat.tool_names().await, "exec"));
    assert_eq!(
        chat.call("exec", exec_args("default")).await,
        (
            true,
            "fake limits agents to these namespaces: payments.".to_owned()
        )
    );
    assert!(chat.no_more_cards());
}

#[tokio::test]
async fn an_exec_waits_for_approval_and_a_denied_one_never_runs() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    set_agent(
        &core,
        &id,
        ClusterAgentSettings {
            exec: true,
            ..ClusterAgentSettings::default()
        },
    );
    let mut chat = Chat::start(&core, &id, false).await;
    let call = chat.call_in_background("exec", exec_args("default"));
    let waiting = chat.next_card().await;
    assert_eq!(waiting.state, ChangeState::Waiting);
    assert_eq!(waiting.title, "Run a command in Pod default/p");
    assert_eq!(waiting.command, Some(vec!["ls".to_owned(), "/".to_owned()]));
    assert!(waiting.diff.is_empty());
    assert_eq!(waiting.rollout, None);
    chat.approvals
        .answer(&waiting.id, ChangeAnswer::Deny)
        .unwrap();
    assert_eq!(call.await.unwrap(), (true, DENIED.to_owned()));
    assert_eq!(chat.next_card().await.state, ChangeState::Denied);
}

#[tokio::test]
async fn apply_creates_then_changes_one_object() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    let (failed, text) = chat
        .call(
            "apply_object",
            json!({ "yaml": MADE, "summary": "Add made" }),
        )
        .await;
    assert!(!failed, "{text}");
    let created = chat.next_card().await;
    assert_eq!(created.title, "Create ConfigMap default/made");
    assert!(
        created.diff.iter().all(|line| line.kind == DiffKind::Added),
        "{:?}",
        created.diff
    );
    assert!(
        created.diff.contains(&added("  a: one")),
        "{:?}",
        created.diff
    );
    assert_eq!(
        dry_runs(&fake, CONFIGMAP_MADE),
        [Some("All".to_owned()), None]
    );

    let changed = MADE.replace("a: one", "a: two");
    let (failed, text) = chat
        .call(
            "apply_object",
            json!({ "yaml": changed, "summary": "Set a" }),
        )
        .await;
    assert!(!failed, "{text}");
    let card = chat.next_card().await;
    assert_eq!(card.title, "Change ConfigMap default/made");
    assert!(card.diff.contains(&removed("  a: one")), "{:?}", card.diff);
    assert!(card.diff.contains(&added("  a: two")), "{:?}", card.diff);
    assert_eq!(value_of(&core, &id, "default", "made").await, "two");
}

#[tokio::test]
async fn apply_object_takes_one_object_per_call() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    assert_eq!(
        chat.call(
            "apply_object",
            json!({ "yaml": TWO_DOCUMENTS, "summary": "Add two" })
        )
        .await,
        (true, "Apply one object per call.".to_owned())
    );
    assert!(chat.no_more_cards());
    assert!(fake
        .writes("PATCH", "/api/v1/namespaces/default/configmaps/a")
        .is_empty());
}

#[tokio::test]
async fn scale_shows_the_old_and_new_replicas_and_names_the_rollout() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("deployments", deployment("web", 1));
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    let scale = json!({
        "kind": "Deployment", "namespace": "default", "name": "web", "replicas": 3,
        "summary": "Scale web to 3",
    });
    let (failed, text) = chat.call("scale", scale).await;
    assert!(!failed, "{text}");
    assert!(text.starts_with("Applied."), "{text}");
    let done = chat.next_card().await;
    assert_eq!(done.title, "Scale Deployment default/web to 3");
    assert_eq!(done.diff, [removed("replicas: 1"), added("replicas: 3")]);
    assert_eq!(
        done.rollout,
        Some(RolloutTarget {
            cluster_id: id.clone(),
            resource: deployments(),
            namespace: "default".to_owned(),
            name: "web".to_owned(),
        })
    );
    let writes = fake.writes("PATCH", &format!("{DEPLOYMENT_WEB}/scale"));
    assert_eq!(writes[0].body, json!({ "spec": { "replicas": 3 } }));
}

#[tokio::test]
async fn restart_has_no_diff_and_names_the_rollout() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("deployments", deployment("web", 1));
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    let restart = json!({ "kind": "deployments", "namespace": "default", "name": "web", "summary": "Restart web" });
    let (failed, text) = chat.call("restart", restart).await;
    assert!(!failed, "{text}");
    let done = chat.next_card().await;
    assert_eq!(done.title, "Restart Deployment default/web");
    assert!(done.diff.is_empty());
    assert!(done.rollout.is_some());
    let writes = fake.writes("PATCH", DEPLOYMENT_WEB);
    assert!(writes[0]
        .body
        .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt")
        .is_some());
}

#[tokio::test]
async fn a_kind_with_no_rollout_cannot_be_restarted_or_scaled() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    let restart =
        json!({ "kind": "ConfigMap", "namespace": "default", "name": "c", "summary": "Restart c" });
    assert_eq!(
        chat.call("restart", restart).await,
        (true, "ConfigMap cannot be restarted".to_owned())
    );
    let scale = json!({ "kind": "ConfigMap", "namespace": "default", "name": "c", "replicas": 2, "summary": "Scale c" });
    assert_eq!(
        chat.call("scale", scale).await,
        (true, "ConfigMap cannot be scaled".to_owned())
    );
    assert!(chat.no_more_cards());
}

#[tokio::test]
async fn delete_says_deleted() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    let (failed, text) = chat
        .call(
            "delete_object",
            delete_args("ConfigMap", Some("default"), "c"),
        )
        .await;
    assert!(!failed, "{text}");
    assert_eq!(text, "Applied.");
    let done = chat.next_card().await;
    assert_eq!(done.title, "Delete ConfigMap default/c");
    assert_eq!(done.result.as_deref(), Some("Deleted."));
    assert!(done.diff.is_empty());
    assert_eq!(done.rollout, None);
    let gone = core
        .resource_get(&id, &configmaps(), Some("default"), "c")
        .await
        .unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn a_change_the_api_refuses_ends_failed_on_its_card() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    fake.fail_writes_to("configmaps", "c", Some(409));
    set_changes(&core, &id, AgentChanges::DontAsk);
    let mut chat = Chat::start(&core, &id, false).await;
    assert_eq!(
        chat.call(
            "delete_object",
            delete_args("ConfigMap", Some("default"), "c")
        )
        .await,
        (true, "injected failure with status 409".to_owned())
    );
    assert_eq!(
        chat.next_card().await.state,
        ChangeState::Failed {
            message: "injected failure with status 409".to_owned()
        }
    );
}

#[tokio::test]
async fn an_unknown_kind_or_a_disconnected_cluster_is_refused_without_a_card() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("configmaps", configmap("default", "c", "one"));
    let mut chat = Chat::start(&core, &id, false).await;
    let widget = json!({
        "kind": "Widget", "namespace": "default", "name": "c",
        "patch": { "a": 1 }, "patch_type": "merge", "summary": "Set a",
    });
    let (failed, _) = chat.call("patch_object", widget).await;
    assert!(failed);
    assert!(chat.no_more_cards());

    core.cluster_disconnect(&id).await.unwrap();
    assert_eq!(
        chat.call("patch_object", patch_args("default", "c", "two"))
            .await,
        (
            true,
            "fake is not connected. Ask the person to connect it.".to_owned()
        )
    );
    assert!(chat.no_more_cards());
    assert!(fake.writes("PATCH", CONFIGMAP_C).is_empty());
}
