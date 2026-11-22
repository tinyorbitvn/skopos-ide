//! The agent settings (agents spec §3.5, §3.6, §4.8) against real files in temp dirs:
//! Preferences' domains and folders, each cluster's agent settings, and files saved before
//! agents existed. Windows refuses every agent call, which `agents::tests` checks.
#![cfg(not(windows))]

use std::path::PathBuf;

use skopos_core::app_core::{AppCore, CoreEvent};
use skopos_core::error::ErrorCode;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::{
    AgentChanges, AgentPrefs, ClusterAgentSettings, ClusterSettings, Prefs, Theme,
};
use tempfile::TempDir;

/// Agent settings do not need the cluster in the catalog.
fn cluster() -> String {
    "c".repeat(32)
}

/// A temp root holding the app's folders and an empty home folder.
struct Fixture {
    root: TempDir,
}

impl Fixture {
    fn new() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        Fixture { root }
    }

    fn home(&self) -> PathBuf {
        self.root.path().join("home")
    }

    fn paths(&self) -> AppPaths {
        AppPaths::under(&self.root.path().join("app"), &self.home())
    }

    async fn start(&self) -> AppCore {
        AppCore::start_with_kubeconfig_env(self.paths(), None)
            .await
            .unwrap()
    }

    /// Writes a store file as the app saves it: `data` inside a version 1 envelope.
    fn write_store(&self, file: &str, data: &str) {
        let config = self.paths().config;
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join(file),
            format!(r#"{{"version":1,"data":{data}}}"#),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn files_saved_before_agents_existed_load_with_the_agent_defaults() {
    let fixture = Fixture::new();
    let id = cluster();
    // What 0.9.0 saved: no `agents` in the preferences, no `agent` in a cluster's settings.
    fixture.write_store(
        "prefs.json",
        r#"{"theme":"dark","syncSources":[],"updateCheck":false}"#,
    );
    fixture.write_store(
        "clusters.json",
        &format!(r#"{{"{id}":{{"displayName":"Prod","accessibleNamespaces":["shop"]}}}}"#),
    );
    let core = fixture.start().await;

    let warnings = core.take_startup_warnings();
    assert!(warnings.is_empty(), "{warnings:?}");
    let prefs = core.prefs_get();
    assert_eq!(prefs.theme, Theme::Dark);
    assert!(!prefs.update_check);
    assert_eq!(core.agent_prefs(), AgentPrefs::default());
    let settings = core.cluster_settings_get(&id);
    assert_eq!(settings.display_name.as_deref(), Some("Prod"));
    assert_eq!(settings.accessible_namespaces, ["shop"]);
    assert_eq!(
        core.cluster_agent_settings(&id),
        ClusterAgentSettings::default()
    );
    assert_eq!(core.cluster_agent_settings(&id).changes, AgentChanges::Ask);
    // A cluster with no saved settings reads the same defaults.
    assert_eq!(
        core.cluster_agent_settings(&"d".repeat(32)),
        ClusterAgentSettings::default()
    );
    core.shutdown().await;
}

#[tokio::test]
async fn domains_are_checked_added_once_and_removed() {
    let fixture = Fixture::new();
    let core = fixture.start().await;

    let prefs = core.agent_domain_add(" Registry.NPMJS.org ").unwrap();
    assert_eq!(prefs.domains, ["registry.npmjs.org"]);
    let taken = core.agent_domain_add("registry.npmjs.org").unwrap_err();
    assert_eq!(taken.code, ErrorCode::InvalidInput);
    assert_eq!(taken.message, "That domain is already in the list");
    for bad in [
        "localhost",
        "10.0.0.1",
        "example.com:8443",
        "https://example.com",
        "my domain.com",
    ] {
        let error = core.agent_domain_add(bad).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{bad}");
        assert_eq!(error.message, "Enter a domain such as example.com", "{bad}");
    }
    core.agent_domain_add("example.com").unwrap();
    let prefs = core.agent_domain_remove("registry.npmjs.org").unwrap();
    assert_eq!(prefs.domains, ["example.com"]);
    // Removing a domain that is not there changes nothing.
    let prefs = core.agent_domain_remove("other.example").unwrap();
    assert_eq!(prefs.domains, ["example.com"]);
    core.shutdown().await;

    let restarted = fixture.start().await;
    assert_eq!(restarted.agent_prefs().domains, ["example.com"]);
    restarted.shutdown().await;
}

#[tokio::test]
async fn folders_are_checked_kept_as_typed_and_removed() {
    let fixture = Fixture::new();
    let code = fixture.home().join("code");
    std::fs::create_dir_all(&code).unwrap();
    let elsewhere = fixture.root.path().join("manifests");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let core = fixture.start().await;

    let prefs = core.agent_folder_add(" ~/code/ ").unwrap();
    assert_eq!(prefs.folders, ["~/code"]);
    // The same folder typed another way.
    let taken = core.agent_folder_add(code.to_str().unwrap()).unwrap_err();
    assert_eq!(taken.code, ErrorCode::InvalidInput);
    assert_eq!(taken.message, "That folder is already in the list");
    let cases = [
        ("code", "Enter a full path"),
        ("~/missing", "No such folder: ~/missing"),
        (
            "~/",
            "Agents can't read your whole home folder. Pick a folder inside it",
        ),
    ];
    for (typed, message) in cases {
        let error = core.agent_folder_add(typed).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{typed}");
        assert_eq!(error.message, message, "{typed}");
    }
    let prefs = core
        .agent_folder_add(&format!("{}/", elsewhere.display()))
        .unwrap();
    assert_eq!(
        prefs.folders,
        ["~/code".to_owned(), elsewhere.display().to_string()]
    );
    let prefs = core.agent_folder_remove("~/code").unwrap();
    assert_eq!(prefs.folders, [elsewhere.display().to_string()]);
    core.shutdown().await;

    let restarted = fixture.start().await;
    assert_eq!(
        restarted.agent_prefs().folders,
        [elsewhere.display().to_string()]
    );
    restarted.shutdown().await;
}

#[tokio::test]
async fn saving_preferences_keeps_the_agent_settings() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.agent_domain_add("example.com").unwrap();

    // A Preferences page that read the preferences before the domain was added.
    core.prefs_set(Prefs {
        theme: Theme::Dark,
        ..Prefs::default()
    })
    .unwrap();

    assert_eq!(core.prefs_get().theme, Theme::Dark);
    assert_eq!(core.agent_prefs().domains, ["example.com"]);
    core.shutdown().await;
}

#[tokio::test]
async fn the_agent_changes_of_a_cluster_change_alone_and_send_no_event() {
    let fixture = Fixture::new();
    let id = cluster();
    let core = fixture.start().await;
    let saved = ClusterSettings {
        display_name: Some("Prod".to_owned()),
        agent: ClusterAgentSettings {
            namespaces: Some(vec!["shop".to_owned()]),
            exec: true,
            notes: "Deploys go through Argo CD.".to_owned(),
            ..ClusterAgentSettings::default()
        },
        ..ClusterSettings::default()
    };
    core.cluster_settings_set(&id, saved.clone()).unwrap();
    let mut events = core.subscribe();

    core.cluster_agent_changes_set(&id, AgentChanges::ReadOnly)
        .unwrap();

    let mut expected = saved;
    expected.agent.changes = AgentChanges::ReadOnly;
    assert_eq!(core.cluster_settings_get(&id), expected);
    assert_eq!(core.cluster_agent_settings(&id), expected.agent);
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, CoreEvent::CatalogChanged), "{event:?}");
    }
    core.shutdown().await;

    let restarted = fixture.start().await;
    assert_eq!(restarted.cluster_settings_get(&id), expected);
    restarted.shutdown().await;
}

#[tokio::test]
async fn cluster_settings_tidy_the_agent_settings_and_refuse_an_empty_limit_or_long_notes() {
    let fixture = Fixture::new();
    let id = cluster();
    let core = fixture.start().await;
    let with_agent = |agent: ClusterAgentSettings| ClusterSettings {
        agent,
        ..ClusterSettings::default()
    };

    core.cluster_settings_set(
        &id,
        with_agent(ClusterAgentSettings {
            namespaces: Some(vec![" shop ".into(), "ingest".into(), "shop".into()]),
            notes: "  Argo CD owns the Deployments.  ".into(),
            ..ClusterAgentSettings::default()
        }),
    )
    .unwrap();
    let agent = core.cluster_agent_settings(&id);
    assert_eq!(
        agent.namespaces,
        Some(vec!["ingest".to_owned(), "shop".to_owned()])
    );
    assert_eq!(agent.notes, "Argo CD owns the Deployments.");

    let refused = [
        (
            ClusterAgentSettings {
                namespaces: Some(Vec::new()),
                ..ClusterAgentSettings::default()
            },
            "Pick at least one namespace.",
        ),
        (
            ClusterAgentSettings {
                notes: "n".repeat(4_001),
                ..ClusterAgentSettings::default()
            },
            "Notes can have at most 4,000 characters.",
        ),
    ];
    for (agent, message) in refused {
        let error = core
            .cluster_settings_set(&id, with_agent(agent))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.message, message);
    }
    // A refused save leaves the saved settings as they were.
    assert_eq!(core.cluster_agent_settings(&id), agent);
    core.shutdown().await;
}
