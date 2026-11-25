mod commands;
mod events;
mod install_channel;
mod keychain;
mod menu;
mod state;
mod updates;
mod windows;

use std::sync::Arc;

use keychain::KeychainStore;
use skopos_core::app_core::AppCore;
use skopos_core::error::IpcError;
use skopos_core::navigation::stays_in_app;
use skopos_core::paths::AppPaths;
use state::AppState;
use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{Context, Manager, RunEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;

const LOG_FILTER_ENV: &str = "SKOPOS_LOG";
const KEPT_LOG_FILES: usize = 7;

/// The guard flushes buffered lines when dropped. Without a usable log
/// directory the app still runs, without a log file.
fn init_logging(paths: &AppPaths) -> Option<WorkerGuard> {
    // The appender lists the directory for pruning before it would create it.
    let appender = skopos_core::paths::create_private_dir(&paths.logs)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            RollingFileAppender::builder()
                .rotation(Rotation::DAILY)
                .filename_prefix("skopos")
                .filename_suffix("log")
                .max_log_files(KEPT_LOG_FILES)
                .build(&paths.logs)
                .map_err(|e| e.to_string())
        });
    let appender = match appender {
        Ok(appender) => appender,
        Err(e) => {
            eprintln!("cannot log to {}: {e}", paths.logs.display());
            return None;
        }
    };
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env(LOG_FILTER_ENV).unwrap_or_else(|_| EnvFilter::new("info"));
    let installed = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .try_init();
    if let Err(e) = installed {
        eprintln!("cannot install the logger: {e}");
    }
    Some(guard)
}

fn report_failure(message: &impl std::fmt::Display) {
    tracing::error!("skopos failed to start: {message}");
    eprintln!("skopos failed to start: {message}");
}

pub fn run(shell_env_warning: Option<String>) {
    let context = tauri::generate_context!();
    let paths = AppPaths::resolve();
    let log_guard = paths.as_ref().ok().and_then(init_logging);
    if let Some(warning) = shell_env_warning {
        tracing::warn!("{warning}");
    }
    tracing::info!("starting skopos {}", skopos_core::VERSION);
    let channel = install_channel::detect();
    tracing::info!("install channel: {}", channel.label());
    let started = paths.and_then(|paths| {
        let secrets = Arc::new(KeychainStore::new(keychain::SERVICE));
        let kubeconfig_env = std::env::var_os("KUBECONFIG");
        tauri::async_runtime::block_on(AppCore::start_with_secret_store(
            paths,
            kubeconfig_env,
            secrets,
        ))
    });
    match started {
        Ok(core) => run_app(core, log_guard, context, channel),
        Err(err) => {
            report_failure(&err);
            drop(log_guard);
            show_startup_error(&err, context);
        }
    }
}

/// Keeps every window on the app's own pages, since a page a window loads can call every
/// command. A link meant for the browser goes through `open_external` and never loads
/// here. No automated test reaches this hook; the core's `stays_in_app` has its own.
fn navigation_guard() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let config = webview.config();
            // The development server is one of the app's pages only while the app runs from it.
            let dev = config.build.dev_url.as_ref().filter(|_| tauri::is_dev());
            let stays = stays_in_app(url, dev);
            if !stays {
                // The rest of the address can hold anything, so only its start is logged.
                tracing::warn!(
                    "window {} was kept from loading a page of {}://{}",
                    webview.label(),
                    url.scheme(),
                    url.host_str().unwrap_or_default()
                );
            }
            stays
        })
        .build()
}

/// Set to `1` by the end-to-end tests: agents then run without the sandbox, which the test
/// machine's AppArmor keeps bubblewrap from starting (agents panel plan P15). Only a build
/// with the `e2e` feature reads it, so a shipped app always sandboxes agents.
#[cfg(feature = "e2e")]
const E2E_AGENT_SANDBOX_OFF: &str = "SKOPOS_E2E_AGENT_SANDBOX_OFF";

#[cfg(feature = "e2e")]
fn sandbox_off_requested(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|value| value == "1")
}

fn run_app(
    core: AppCore,
    mut log_guard: Option<WorkerGuard>,
    context: Context<Wry>,
    channel: install_channel::InstallChannel,
) {
    #[cfg(feature = "e2e")]
    if sandbox_off_requested(std::env::var_os(E2E_AGENT_SANDBOX_OFF).as_deref()) {
        core.agent_sandbox_off_for_test();
    }
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let forwarded = core.clone();
    let built = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(navigation_guard())
        .manage(AppState { core: core.clone() })
        .manage(windows::WindowTracker::default())
        .on_window_event(windows::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::catalog::catalog_list,
            commands::catalog::catalog_warnings,
            commands::catalog::catalog_add_pasted,
            commands::catalog::catalog_remove_pasted,
            commands::catalog::catalog_folders,
            commands::catalog::catalog_folder_create,
            commands::catalog::catalog_folder_rename,
            commands::catalog::catalog_folder_move,
            commands::catalog::catalog_folder_delete,
            commands::catalog::catalog_cluster_place,
            commands::cluster::cluster_connect,
            commands::cluster::cluster_disconnect,
            commands::cluster::cluster_exec_request,
            commands::cluster::cluster_exec_request_details,
            commands::cluster::cluster_exec_allow,
            commands::cluster::cluster_exec_forget,
            commands::cluster::cluster_state,
            commands::cluster::cluster_control_plane,
            commands::cluster::cluster_log,
            commands::actions::workload_scale,
            commands::actions::pod_force_delete,
            commands::actions::resource_force_finalize,
            commands::actions::job_set_suspend,
            commands::actions::ingress_class_set_default,
            commands::actions::service_account_kubeconfig_save,
            commands::actions::workload_restart,
            commands::actions::pod_evict,
            commands::actions::pvc_resize,
            commands::actions::cronjob_trigger,
            commands::actions::cronjob_set_suspend,
            commands::actions::node_set_unschedulable,
            commands::actions::node_drain_start,
            commands::actions::node_drain_cancel,
            commands::access::cert_user_create_start,
            commands::access::cert_user_create_cancel,
            commands::access::access_subject_remove,
            commands::access::csr_review,
            commands::access::csr_set_approval,
            commands::access::certificate_request_describe,
            commands::actions::secret_reveal,
            commands::actions::secret_update,
            commands::actions::configmap_update,
            commands::argocd::argocd_sync,
            commands::argocd::argocd_rollback,
            commands::argocd::argocd_terminate,
            commands::argocd::argocd_refresh,
            commands::argocd::argocd_delete,
            commands::logs::logs_start,
            commands::logs::logs_stop,
            commands::logs::logs_download,
            commands::portforward::portforward_list,
            commands::portforward::portforward_add,
            commands::portforward::portforward_start,
            commands::portforward::portforward_stop,
            commands::portforward::portforward_remove,
            commands::portforward::open_external,
            commands::sessions::terminal_start,
            commands::sessions::pod_exec_start,
            commands::sessions::pod_attach_start,
            commands::sessions::node_shell_start,
            commands::sessions::session_write,
            commands::sessions::session_resize,
            commands::sessions::session_ack,
            commands::sessions::session_stop,
            commands::resources::resources_discover,
            commands::resources::resources_names,
            commands::resources::resources_subscribe,
            commands::resources::resources_subscribe_object,
            commands::resources::resources_subscribe_node_pods,
            commands::resources::resources_unsubscribe,
            commands::graph::resource_graph_subscribe,
            commands::graph::resource_graph_unsubscribe,
            commands::topology::node_topology_subscribe,
            commands::topology::node_topology_unsubscribe,
            commands::network::network_reachability_subscribe,
            commands::network::network_reachability_unsubscribe,
            commands::map::map_export,
            commands::resources::resources_list,
            commands::resources::resource_get,
            commands::resources::resource_get_yaml,
            commands::resources::resource_replace,
            commands::resources::resource_apply,
            commands::resources::resource_delete,
            commands::resources::resource_events,
            commands::resources::api_schema,
            commands::resources::ui_state_get,
            commands::resources::ui_state_set,
            commands::settings::cluster_settings_get,
            commands::settings::cluster_settings_set,
            commands::settings::hotbar_get,
            commands::settings::hotbar_set,
            commands::settings::prefs_get,
            commands::settings::prefs_set,
            commands::tools::tools_status,
            commands::tools::tools_download,
            commands::tools::tools_download_cancel,
            commands::helm::helm_version,
            commands::helm::helm_repo_list,
            commands::helm::helm_repo_add,
            commands::helm::helm_repo_remove,
            commands::helm::helm_repo_update,
            commands::helm::helm_chart_search,
            commands::helm::helm_chart_versions,
            commands::helm::helm_chart_readme,
            commands::helm::helm_chart_values,
            commands::helm::helm_release_list,
            commands::helm::helm_release_get,
            commands::helm::helm_release_values,
            commands::helm::helm_release_history,
            commands::helm::helm_releases_subscribe,
            commands::helm::helm_releases_unsubscribe,
            commands::helm::helm_install_preview,
            commands::helm::helm_upgrade_preview,
            commands::helm::helm_install_start,
            commands::helm::helm_upgrade_start,
            commands::helm::helm_rollback_start,
            commands::helm::helm_uninstall_start,
            commands::metrics::metrics_provider,
            commands::metrics::metrics_query,
            commands::metrics::metrics_usage,
            commands::metrics::nodes_disk_usage,
            commands::metrics::volumes_usage,
            commands::metrics::metrics_secret_set,
            commands::metrics::metrics_secret_saved,
            commands::windows::window_layout_get,
            commands::windows::window_layout_set,
            commands::windows::windows_list,
            commands::windows::window_flushed,
            commands::windows::window_tab_move,
            commands::windows::window_tab_drop,
            commands::updates::update_state_get,
            commands::updates::update_check,
            commands::updates::update_install,
            commands::updates::update_cancel,
            commands::updates::update_skip,
            commands::agents::agents_status,
            commands::agents::agent_probe,
            commands::agents::agent_custom_add,
            commands::agents::agent_custom_remove,
            commands::agents::agent_default_set,
            commands::agents::agent_prefs,
            commands::agents::agent_domain_add,
            commands::agents::agent_domain_remove,
            commands::agents::agent_folder_add,
            commands::agents::agent_folder_remove,
            commands::agents::agent_sandbox_status,
            commands::agents::cluster_agent_changes_set,
            commands::agents::cluster_agent_settings,
            commands::agents::chat_start,
            commands::agents::chat_prompt,
            commands::agents::chat_stop,
            commands::agents::chat_close,
            commands::agents::chat_answer,
            commands::agents::chat_proposal_answer,
            commands::agents::chat_detach_tab,
            commands::agents::chat_undo_standing,
            commands::agents::chat_list,
            commands::agents::chat_get,
        ])
        .setup(move |app| {
            windows::restore(app.handle(), &forwarded);
            let updates_core = forwarded.clone();
            // The forwarder subscribes first, so the update service's first state is sent on.
            events::spawn_forwarder(app.handle().clone(), forwarded);
            updates::start(app.handle(), &updates_core, channel);
            #[cfg(target_os = "macos")]
            menu::install(app.handle())?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            let state = webview.state::<AppState>();
            match payload.event() {
                // This window is replacing its page, and the new one cannot know the old
                // one's drains, certificate user runs, sessions or subscriptions; other windows keep theirs (P36).
                // Route changes use the hash, so they load nothing. Port-forwards go on:
                // the new page lists them. No automated test reaches this hook. The core's
                // `sessions_stop_owned`, `node_drain_cancel_owned`,
                // `cert_user_create_cancel_owned` and `subscriptions_stop_owned` have their own tests.
                PageLoadEvent::Started => {
                    tracing::info!("window {} started loading its page", webview.label());
                    state.core.node_drain_cancel_owned(webview.label());
                    state.core.cert_user_create_cancel_owned(webview.label());
                    state.core.sessions_stop_owned(webview.label());
                    state.core.subscriptions_stop_owned(webview.label());
                }
                PageLoadEvent::Finished => {
                    tracing::info!("window {} finished loading its page", webview.label());
                    events::send_startup_warnings(webview.app_handle(), &state.core);
                }
            }
        })
        .build(context);
    let app = match built {
        Ok(app) => app,
        Err(err) => {
            report_failure(&err);
            drop(log_guard);
            std::process::exit(1);
        }
    };
    app.run(move |app, event| match event {
        // Windows that close from here on keep their layouts for the next start (P34).
        RunEvent::ExitRequested { code, .. } => {
            windows::quitting(app, &format!("exit requested with code {code:?}"));
        }
        RunEvent::Exit => {
            windows::quitting(app, "event loop ended; the core shuts down");
            tauri::async_runtime::block_on(core.shutdown());
            core.quit().step("core shut down; the process ends");
            log_guard.take();
        }
        _ => {}
    });
}

/// Runs a windowless app that only shows the error, then exits with code 1.
fn show_startup_error(err: &IpcError, mut context: Context<Wry>) -> ! {
    context.config_mut().app.windows.clear();
    let message = err.to_string();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            app.dialog()
                .message(message)
                .title("SkoposIDE could not start")
                .kind(MessageDialogKind::Error)
                .show(move |_| handle.exit(1));
            Ok(())
        })
        .run(context);
    if let Err(e) = result {
        eprintln!("cannot show the error dialog: {e}");
    }
    std::process::exit(1);
}

#[cfg(test)]
mod capability_tests {
    #[test]
    fn webview_has_no_opener_permission() {
        let raw = include_str!("../capabilities/default.json");
        assert!(
            !raw.contains("opener"),
            "the webview must not hold an opener permission (spec 5.5)"
        );
    }

    /// Spec P32: every window has the same permissions, the test driver's included.
    #[test]
    fn every_window_has_the_same_capabilities() {
        for raw in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities-e2e/e2e.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(raw).unwrap();
            assert_eq!(
                capability["windows"],
                serde_json::json!(["main", "window-*"])
            );
        }
    }

    /// In-app update spec §4: the UI calls our commands, so the webview gets no updater API.
    #[test]
    fn webview_has_no_updater_permission() {
        for raw in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities-e2e/e2e.json"),
        ] {
            assert!(!raw.contains("updater"));
        }
    }

    /// A command that writes a file opens the save dialog itself, so a page holds only
    /// the dialog that picks a file to read: with the save dialog it could still ask for
    /// a path, and with the default set it would get it back.
    #[test]
    fn the_webview_opens_no_save_dialog() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let dialog: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(serde_json::Value::as_str)
            .filter(|permission| permission.starts_with("dialog:"))
            .collect();
        assert_eq!(dialog, ["dialog:allow-open"]);
    }

    /// Spec P35: the core owns window bounds, so the window-state plugin is gone.
    #[test]
    fn the_window_state_plugin_is_gone() {
        assert!(!include_str!("../capabilities/default.json").contains("window-state"));
        assert!(!include_str!("../Cargo.toml").contains("window-state"));
    }
}

#[cfg(test)]
mod bundle_tests {
    use std::path::Path;

    /// Spec C §8.4: the notices and the license are installed with the app.
    #[test]
    fn notices_and_license_are_installed_with_the_app() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let resources = &config["bundle"]["resources"];
        assert_eq!(
            resources["../../THIRD_PARTY_NOTICES.md"],
            "THIRD_PARTY_NOTICES.md"
        );
        assert_eq!(resources["../../LICENSE"], "LICENSE");
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        for source in ["../../THIRD_PARTY_NOTICES.md", "../../LICENSE"] {
            assert!(crate_dir.join(source).is_file(), "{source} is missing");
        }
    }
}

#[cfg(test)]
mod updater_config_tests {
    fn config() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    /// In-app update spec §6.2: the app trusts only the key whose private half signs releases.
    #[test]
    fn the_updater_trusts_the_committed_key_and_asks_the_latest_release() {
        let config = config();
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["pubkey"], include_str!("../updater.key.pub").trim());
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([
                "https://github.com/tinyorbitvn/skopos-ide/releases/latest/download/latest.json"
            ])
        );
        assert_eq!(updater["windows"]["installMode"], "passive");
    }

    /// Without the private key every CI, e2e and local build would fail: only the release
    /// build makes updater files (spec §6.2).
    #[test]
    fn only_the_release_build_makes_updater_files() {
        assert!(config()["bundle"].get("createUpdaterArtifacts").is_none());
    }
}

#[cfg(test)]
mod command_tests {
    use std::collections::BTreeSet;

    /// The agent and chat commands (agents spec §5.2).
    const AGENT_COMMANDS: [&str; 23] = [
        "agents_status",
        "agent_probe",
        "agent_custom_add",
        "agent_custom_remove",
        "agent_default_set",
        "agent_prefs",
        "agent_domain_add",
        "agent_domain_remove",
        "agent_folder_add",
        "agent_folder_remove",
        "agent_sandbox_status",
        "cluster_agent_changes_set",
        "cluster_agent_settings",
        "chat_start",
        "chat_prompt",
        "chat_stop",
        "chat_close",
        "chat_answer",
        "chat_proposal_answer",
        "chat_detach_tab",
        "chat_undo_standing",
        "chat_list",
        "chat_get",
    ];

    /// The command names the `generate_handler!` list of this file registers.
    fn registered(source: &str) -> BTreeSet<&str> {
        let open = "generate_handler![";
        let start = source.find(open).expect("lib.rs registers its commands") + open.len();
        let list = &source[start..];
        let end = list.find(']').expect("the command list ends");
        list[..end]
            .split(',')
            .filter_map(|entry| entry.trim().strip_prefix("commands::"))
            .filter_map(|path| path.rsplit("::").next())
            .collect()
    }

    /// The names `api.ts` passes to `call`, as in `call<T>("name"` or `call("name"`.
    fn called(source: &str) -> BTreeSet<&str> {
        let mut names = BTreeSet::new();
        for (at, _) in source.match_indices("call") {
            let starts_word = source[..at]
                .chars()
                .next_back()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '.'));
            let after = &source[at + "call".len()..];
            if !starts_word || !(after.starts_with('<') || after.starts_with('(')) {
                continue;
            }
            let Some(open) = after.find('(') else {
                continue;
            };
            let Some(quoted) = after[open + 1..].trim_start().strip_prefix('"') else {
                continue;
            };
            if let Some(end) = quoted.find('"') {
                names.insert(&quoted[..end]);
            }
        }
        names
    }

    #[test]
    fn the_agent_commands_are_registered() {
        let registered = registered(include_str!("lib.rs"));
        let missing: Vec<&str> = AGENT_COMMANDS
            .into_iter()
            .filter(|name| !registered.contains(name))
            .collect();
        assert!(missing.is_empty(), "not registered: {missing:?}");
    }

    #[test]
    fn every_command_the_ui_calls_is_registered() {
        let registered = registered(include_str!("lib.rs"));
        let called = called(include_str!("../../../ui/src/ipc/api.ts"));
        // The parser must see the wrappers, or the check below proves nothing.
        assert!(called.contains("app_info") && called.contains("logs_start"));
        let missing: Vec<&str> = called
            .into_iter()
            .filter(|name| !registered.contains(name))
            .collect();
        assert!(
            missing.is_empty(),
            "api.ts calls unregistered commands: {missing:?}"
        );
    }
}

#[cfg(all(test, feature = "e2e"))]
mod e2e_switch_tests {
    use super::sandbox_off_requested;
    use std::ffi::OsStr;

    #[test]
    fn sandbox_off_needs_the_value_one() {
        assert!(sandbox_off_requested(Some(OsStr::new("1"))));
        assert!(!sandbox_off_requested(Some(OsStr::new("0"))));
        assert!(!sandbox_off_requested(Some(OsStr::new(""))));
        assert!(!sandbox_off_requested(None));
    }
}
