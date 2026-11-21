//! Consent before a kubeconfig runs a program, against the fake API server.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.
#![cfg(unix)]

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use skopos_core::app_core::AppCore;
use skopos_core::cluster::{ConnectionState, ExecCommandKind, FailureKind};
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_fakekube::{FakeKube, FakeKubeConfig};
use tempfile::TempDir;

const CONTEXT: &str = "fake";
const LIMIT: Duration = Duration::from_secs(3);
const CONSENTS_FILE: &str = "exec-consents.json";

fn paths_in(root: &TempDir) -> AppPaths {
    AppPaths::under(&root.path().join("app"), &root.path().join("home"))
}

fn kube_config(root: &TempDir) -> PathBuf {
    let dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("config")
}

async fn start_core(root: &TempDir) -> AppCore {
    AppCore::start_with_kubeconfig_env(paths_in(root), None)
        .await
        .unwrap()
}

async fn wait_until<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let started = Instant::now();
    while !check().await {
        assert!(started.elapsed() < LIMIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_entry(core: &AppCore) -> ClusterId {
    wait_until("the catalog entry", || async {
        core.catalog_list()
            .iter()
            .any(|entry| entry.context_name == CONTEXT)
    })
    .await;
    let entries = core.catalog_list();
    let entry = entries.iter().find(|entry| entry.context_name == CONTEXT);
    entry.unwrap().id.clone()
}

/// One context named `CONTEXT`, whose user is given as YAML.
fn config_text(server: &str, user: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Config\n\
         clusters:\n- {{ name: c1, cluster: {{ server: \"{server}\" }} }}\n\
         users:\n- name: u1\n  user: {user}\n\
         contexts:\n- {{ name: {CONTEXT}, context: {{ cluster: c1, user: u1 }} }}\n\
         current-context: {CONTEXT}\n"
    )
}

/// A plugin that leaves `marker` behind and prints a token. The script ignores `tag`,
/// so a test can change the arguments without changing what the plugin does.
fn plugin_user(marker: &Path, tag: &str) -> String {
    let script = format!(
        "touch '{}'; echo '{{\"apiVersion\":\"client.authentication.k8s.io/v1\",\
         \"kind\":\"ExecCredential\",\"status\":{{\"token\":\"from-plugin\"}}}}'",
        marker.display()
    );
    let args = ["-c", script.as_str(), tag]
        .map(|arg| serde_json::to_string(arg).unwrap())
        .join(", ");
    format!(
        "{{ exec: {{ apiVersion: client.authentication.k8s.io/v1, command: \"/bin/sh\", \
         args: [{args}], interactiveMode: Never }} }}"
    )
}

fn failure(state: &ConnectionState) -> (FailureKind, &str) {
    match state {
        ConnectionState::Failed { kind, message } => (*kind, message),
        other => panic!("expected Failed, got {other:?}"),
    }
}

fn consents_text(root: &TempDir) -> String {
    std::fs::read_to_string(paths_in(root).config.join(CONSENTS_FILE)).unwrap_or_default()
}

struct Setup {
    core: AppCore,
    fake: FakeKube,
    id: ClusterId,
    root: TempDir,
    marker: PathBuf,
}

/// A core whose one cluster signs in through `plugin_user`, not yet allowed.
async fn core_with_plugin() -> Setup {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("plugin-ran");
    let text = config_text(&fake.url(), &plugin_user(&marker, "one"));
    std::fs::write(kube_config(&root), text).unwrap();
    let core = start_core(&root).await;
    let id = wait_for_entry(&core).await;
    Setup {
        core,
        fake,
        id,
        root,
        marker,
    }
}

/// Connects, expects the refusal, and allows what was refused, as the dialog does.
async fn allow(core: &AppCore, id: &ClusterId) {
    let state = core.cluster_connect(id).await.unwrap();
    assert_eq!(failure(&state).0, FailureKind::ExecNotAllowed);
    let request = core.cluster_exec_request(id).unwrap();
    core.cluster_exec_allow(id, request.request_id).unwrap();
}

async fn connected(core: &AppCore, id: &ClusterId) {
    let state = core.cluster_connect(id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
}

#[tokio::test]
async fn a_connect_does_not_run_a_plugin_that_was_not_allowed() {
    let s = core_with_plugin().await;

    let state = s.core.cluster_connect(&s.id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::ExecNotAllowed);
    assert!(message.contains("/bin/sh"), "{message}");
    assert_eq!(
        serde_json::to_value(&state).unwrap()["kind"],
        "execNotAllowed"
    );
    assert!(!s.marker.exists(), "the plugin ran");
    let extracted = paths_in(&s.root)
        .data
        .join("runtime")
        .join(format!("{}.yaml", s.id));
    assert!(
        !extracted.exists(),
        "the extracted kubeconfig was left behind"
    );
}

#[tokio::test]
async fn the_request_says_what_was_refused() {
    let s = core_with_plugin().await;
    s.core.cluster_connect(&s.id).await.unwrap();

    let request = s.core.cluster_exec_request(&s.id).unwrap();

    assert_eq!(request.kind, ExecCommandKind::Exec);
    assert_eq!(request.command, "/bin/sh");
    assert_eq!(request.arg_count, 3);
    assert!(request.env_names.is_empty());
    assert_eq!(request.server, s.fake.url());
    assert_eq!(request.context_name, CONTEXT);
    assert!(
        Path::new(&request.source_path).ends_with(".kube/config"),
        "{}",
        request.source_path
    );
    assert!(!request.changed);
}

#[tokio::test]
async fn an_allowed_plugin_runs_and_connects_without_asking_again() {
    let s = core_with_plugin().await;
    allow(&s.core, &s.id).await;
    assert!(!s.marker.exists(), "allowing ran the plugin");

    connected(&s.core, &s.id).await;

    assert!(s.marker.exists());
    s.core.cluster_disconnect(&s.id).await.unwrap();
    connected(&s.core, &s.id).await;
}

#[tokio::test]
async fn a_changed_argument_asks_again_and_says_so() {
    let s = core_with_plugin().await;
    allow(&s.core, &s.id).await;
    connected(&s.core, &s.id).await;
    s.core.cluster_disconnect(&s.id).await.unwrap();
    let second = s.root.path().join("second-plugin-ran");
    let text = config_text(&s.fake.url(), &plugin_user(&second, "two"));
    std::fs::write(kube_config(&s.root), text).unwrap();

    let state = s.core.cluster_connect(&s.id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::ExecNotAllowed);
    assert!(message.contains("changed"), "{message}");
    assert!(s.core.cluster_exec_request(&s.id).unwrap().changed);
    assert!(!second.exists(), "the changed plugin ran");
}

#[tokio::test]
async fn a_changed_server_asks_again() {
    let s = core_with_plugin().await;
    allow(&s.core, &s.id).await;
    connected(&s.core, &s.id).await;
    s.core.cluster_disconnect(&s.id).await.unwrap();
    std::fs::remove_file(&s.marker).unwrap();
    let other = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let text = config_text(&other.url(), &plugin_user(&s.marker, "one"));
    std::fs::write(kube_config(&s.root), text).unwrap();

    let state = s.core.cluster_connect(&s.id).await.unwrap();

    assert_eq!(failure(&state).0, FailureKind::ExecNotAllowed);
    let request = s.core.cluster_exec_request(&s.id).unwrap();
    assert!(request.changed);
    assert_eq!(request.server, other.url());
    assert!(!s.marker.exists(), "the plugin ran for another server");
}

#[tokio::test]
async fn a_change_elsewhere_in_the_file_does_not_ask_again() {
    let s = core_with_plugin().await;
    allow(&s.core, &s.id).await;
    connected(&s.core, &s.id).await;
    s.core.cluster_disconnect(&s.id).await.unwrap();
    // Another user and another context beside the one that was allowed.
    let text = config_text(&s.fake.url(), &plugin_user(&s.marker, "one")).replace(
        "contexts:\n",
        "- { name: other, user: { token: t } }\n\
         contexts:\n\
         - { name: other, context: { cluster: c1, user: other } }\n",
    );
    std::fs::write(kube_config(&s.root), text).unwrap();

    connected(&s.core, &s.id).await;
}

#[tokio::test]
async fn a_consent_outlives_a_restart() {
    let s = core_with_plugin().await;
    allow(&s.core, &s.id).await;
    s.core.shutdown().await;

    let reopened = start_core(&s.root).await;
    let id = wait_for_entry(&reopened).await;

    assert_eq!(id, s.id);
    connected(&reopened, &id).await;
    reopened.shutdown().await;
}

#[tokio::test]
async fn allowing_a_request_that_is_no_longer_held_stores_nothing() {
    let s = core_with_plugin().await;
    s.core.cluster_connect(&s.id).await.unwrap();
    let first = s.core.cluster_exec_request(&s.id).unwrap();
    s.core.cluster_connect(&s.id).await.unwrap();
    let second = s.core.cluster_exec_request(&s.id).unwrap();
    assert_ne!(first.request_id, second.request_id);

    let err = s
        .core
        .cluster_exec_allow(&s.id, first.request_id)
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(!consents_text(&s.root).contains(s.id.as_str()));
    let state = s.core.cluster_connect(&s.id).await.unwrap();
    assert_eq!(failure(&state).0, FailureKind::ExecNotAllowed);
    assert!(!s.marker.exists());
}

#[tokio::test]
async fn a_disconnect_drops_the_held_request() {
    let s = core_with_plugin().await;
    s.core.cluster_connect(&s.id).await.unwrap();
    let request = s.core.cluster_exec_request(&s.id).unwrap();

    s.core.cluster_disconnect(&s.id).await.unwrap();

    let err = s.core.cluster_exec_request(&s.id).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let err = s
        .core
        .cluster_exec_allow(&s.id, request.request_id)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
}

#[tokio::test]
async fn nothing_secret_leaves_with_the_request_the_state_the_log_or_the_store() {
    let root = tempfile::tempdir().unwrap();
    let user = "{ exec: { apiVersion: client.authentication.k8s.io/v1, command: \"/bin/sh\", \
        args: [\"-c\", \"exit 1\", \"--client-secret=S3CRET-ARG\"], \
        env: [{ name: PLUGIN_ENV, value: S3CRET-ENV }], interactiveMode: Never } }";
    std::fs::write(kube_config(&root), config_text("http://127.0.0.1:9", user)).unwrap();
    let core = start_core(&root).await;
    let id = wait_for_entry(&core).await;

    let state = core.cluster_connect(&id).await.unwrap();
    let request = core.cluster_exec_request(&id).unwrap();
    core.cluster_exec_allow(&id, request.request_id).unwrap();

    assert_eq!(request.arg_count, 3);
    assert_eq!(request.env_names, ["PLUGIN_ENV"]);
    let stored = consents_text(&root);
    assert!(stored.contains(id.as_str()), "{stored}");
    let seen = [
        serde_json::to_string(&request).unwrap(),
        serde_json::to_string(&state).unwrap(),
        serde_json::to_string(&core.cluster_log(&id)).unwrap(),
        serde_json::to_string(&core.catalog_list()).unwrap(),
        stored,
    ];
    for text in seen {
        assert!(
            !text.contains("S3CRET-ARG") && !text.contains("S3CRET-ENV"),
            "{text}"
        );
    }
}

#[tokio::test]
async fn a_consent_store_that_cannot_be_read_asks_again() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("plugin-ran");
    let text = config_text(&fake.url(), &plugin_user(&marker, "one"));
    std::fs::write(kube_config(&root), text).unwrap();
    let paths = paths_in(&root);
    std::fs::create_dir_all(&paths.config).unwrap();
    std::fs::write(paths.config.join(CONSENTS_FILE), "{ not json").unwrap();
    let core = start_core(&root).await;
    let id = wait_for_entry(&core).await;

    let state = core.cluster_connect(&id).await.unwrap();

    assert_eq!(failure(&state).0, FailureKind::ExecNotAllowed);
    assert!(!marker.exists());
    let request = core.cluster_exec_request(&id).unwrap();
    core.cluster_exec_allow(&id, request.request_id).unwrap();
    connected(&core, &id).await;
}
