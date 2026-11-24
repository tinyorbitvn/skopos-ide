//! In-app updates through `AppCore`: the event, the skip kept across runs, the toast window.

use std::sync::Arc;

use skopos_core::app_core::{AppCore, CoreEvent};
use skopos_core::error::CoreResult;
use skopos_core::paths::AppPaths;
use skopos_core::updates::{
    BoxFuture, Package, Progress, Release, UpdatePhase, UpdateSource, STORE_MANAGED,
};

struct OneRelease;

impl UpdateSource for OneRelease {
    fn check(&self) -> BoxFuture<'_, CoreResult<Option<Release>>> {
        Box::pin(async {
            Ok(Some(Release {
                version: "0.10.0".into(),
                notes: "- Faster lists".into(),
                date: None,
            }))
        })
    }

    fn download(&self, _progress: Progress) -> BoxFuture<'_, CoreResult<Package>> {
        Box::pin(async {
            Ok(Package {
                version: "0.10.0".into(),
                bytes: Vec::new(),
            })
        })
    }

    fn install(&self, _package: Package) -> CoreResult<()> {
        Ok(())
    }

    fn blocker(&self) -> Option<String> {
        None
    }

    fn installer(&self) -> Option<String> {
        None
    }
}

#[tokio::test]
async fn a_manual_check_reaches_subscribers_and_a_skip_is_kept_across_runs() {
    let root = tempfile::tempdir().unwrap();
    let paths = || AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths(), None)
        .await
        .unwrap();
    assert_eq!(core.window_last_focused(), "main");
    let mut events = core.subscribe();
    core.updates_start(Arc::new(OneRelease), false);

    let state = core.update_check().await;
    assert_eq!(state.current, env!("CARGO_PKG_VERSION"));
    assert!(matches!(
        state.phase,
        UpdatePhase::Available { ref release } if release.version == "0.10.0"
    ));
    let mut phases = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let CoreEvent::UpdateState { state } = event {
            phases.push(state.phase);
        }
    }
    assert!(phases.contains(&UpdatePhase::Checking));

    core.update_skip("0.10.0".into()).unwrap();
    core.shutdown().await;

    let again = AppCore::start_with_kubeconfig_env(paths(), None)
        .await
        .unwrap();
    assert_eq!(again.update_state().skipped.as_deref(), Some("0.10.0"));
    assert_eq!(again.update_state().phase, UpdatePhase::Idle);
    again.shutdown().await;
}

#[tokio::test]
async fn a_store_copy_never_checks_and_refuses_to_install() {
    let root = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let mut events = core.subscribe();
    core.updates_start_store_managed();

    assert_eq!(core.update_state().phase, UpdatePhase::StoreManaged);
    assert_eq!(core.update_check().await.phase, UpdatePhase::StoreManaged);
    let refused = core.update_install().await.unwrap_err();
    assert_eq!(refused.message, STORE_MANAGED);
    assert_eq!(core.update_state().phase, UpdatePhase::StoreManaged);

    let mut phases = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let CoreEvent::UpdateState { state } = event {
            phases.push(state.phase);
        }
    }
    assert_eq!(phases, vec![UpdatePhase::StoreManaged]);
    core.shutdown().await;
}
