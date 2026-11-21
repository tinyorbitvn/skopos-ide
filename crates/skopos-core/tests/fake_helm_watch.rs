//! `helm_releases_subscribe` against the fake API server: a metadata watch on the Secrets
//! labelled `owner=helm`, with a trailing debounce.

mod support;

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::helm::HelmReleasesEvent;
use skopos_fakekube::{FakeKube, FakeKubeConfig};
use support::connected_fake;
use tokio::sync::mpsc;
use tokio::time::timeout;

const SECRETS: &str = "/api/v1/secrets";
/// Short enough for a test, long enough that one burst of upserts falls inside it.
const DEBOUNCE: Duration = Duration::from_millis(150);

fn release_secret(name: &str) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "labels": { "owner": "helm", "name": "web", "status": "deployed" },
        },
        "type": "helm.sh/release.v1",
        "data": { "release": "SECRET-PAYLOAD" },
    })
}

fn plain_secret(name: &str) -> Value {
    json!({ "metadata": { "name": name, "namespace": "default" }, "data": { "k": "dg==" } })
}

async fn until_watching(fake: &FakeKube) {
    let started = Instant::now();
    // A request is counted before its stream is open; an expiry sent in between is lost.
    while fake.watch_request_count(SECRETS) == 0 || fake.open_watch_count() == 0 {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the watcher never started"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn until_open_watches(fake: &FakeKube, count: usize) {
    let started = Instant::now();
    while fake.open_watch_count() != count {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{} watches open, not {count}",
            fake.open_watch_count()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A subscription whose watcher is already watching, so later changes are live events.
async fn watching(
    core: &AppCore,
    fake: &FakeKube,
    id: &str,
) -> (String, mpsc::Receiver<HelmReleasesEvent>) {
    core.set_helm_debounce_for_test(DEBOUNCE);
    let (tx, rx) = mpsc::channel(8);
    let subscription = core
        .helm_releases_subscribe(&id.to_owned(), tx, "main")
        .unwrap();
    until_watching(fake).await;
    (subscription, rx)
}

async fn next(rx: &mut mpsc::Receiver<HelmReleasesEvent>) -> Option<HelmReleasesEvent> {
    timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("no event in 3 s")
}

/// True when nothing arrives within `quiet`.
async fn stays_quiet(rx: &mut mpsc::Receiver<HelmReleasesEvent>, quiet: Duration) -> bool {
    timeout(quiet, rx.recv()).await.is_err()
}

#[tokio::test]
async fn a_burst_of_release_changes_sends_one_changed() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (subscription, mut rx) = watching(&core, &fake, &id).await;
    assert!(subscription.starts_with("helm-"), "{subscription}");

    for revision in 1..=3 {
        fake.upsert(
            "secrets",
            release_secret(&format!("sh.helm.release.v1.web.v{revision}")),
        );
    }

    assert_eq!(next(&mut rx).await, Some(HelmReleasesEvent::Changed));
    assert!(
        stays_quiet(&mut rx, DEBOUNCE * 4).await,
        "a second changed for one burst"
    );

    // A later change is a new burst.
    fake.upsert("secrets", release_secret("sh.helm.release.v1.web.v4"));
    assert_eq!(next(&mut rx).await, Some(HelmReleasesEvent::Changed));
    core.shutdown().await;
}

#[tokio::test]
async fn deleting_a_release_secret_is_a_change() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("secrets", release_secret("sh.helm.release.v1.web.v1"));
    let (_subscription, mut rx) = watching(&core, &fake, &id).await;

    fake.delete("secrets", Some("default"), "sh.helm.release.v1.web.v1");

    assert_eq!(next(&mut rx).await, Some(HelmReleasesEvent::Changed));
    core.shutdown().await;
}

#[tokio::test]
async fn the_initial_listing_is_not_a_change() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert("secrets", release_secret("sh.helm.release.v1.web.v1"));
    fake.upsert("secrets", release_secret("sh.helm.release.v1.api.v1"));
    let (_subscription, mut rx) = watching(&core, &fake, &id).await;

    assert!(
        stays_quiet(&mut rx, DEBOUNCE * 4).await,
        "the secrets that were already there were reported"
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_secret_without_the_helm_label_is_not_a_change() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (_subscription, mut rx) = watching(&core, &fake, &id).await;

    fake.upsert("secrets", plain_secret("db-password"));
    assert!(
        stays_quiet(&mut rx, DEBOUNCE * 4).await,
        "an unlabelled secret was reported"
    );

    // The watcher is alive: a labelled one still comes through.
    fake.upsert("secrets", release_secret("sh.helm.release.v1.web.v1"));
    assert_eq!(next(&mut rx).await, Some(HelmReleasesEvent::Changed));
    core.shutdown().await;
}

#[tokio::test]
async fn a_watch_that_expired_lists_again_and_reports_a_change() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (_subscription, mut rx) = watching(&core, &fake, &id).await;

    // A 410 makes the watcher list again; what happened meanwhile may have been missed.
    fake.expire_watches("secrets");

    assert_eq!(next(&mut rx).await, Some(HelmReleasesEvent::Changed));
    core.shutdown().await;
}

#[tokio::test]
async fn a_forbidden_watch_sends_forbidden_once_and_ends() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.fail_watches_with("secrets", Some(403));
    core.set_helm_debounce_for_test(DEBOUNCE);
    let (tx, mut rx) = mpsc::channel(8);

    core.helm_releases_subscribe(&id, tx, "main").unwrap();

    match next(&mut rx).await {
        Some(HelmReleasesEvent::Forbidden { message }) => {
            assert!(message.contains("injected failure"), "{message}");
            assert!(message.contains("403"), "{message}");
        }
        other => panic!("expected forbidden, got {other:?}"),
    }
    assert_eq!(next(&mut rx).await, None, "the subscription must end");
    core.shutdown().await;
}

#[tokio::test]
async fn any_other_watch_error_sends_failed_once_and_ends() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.fail_watches_with("secrets", Some(500));
    core.set_helm_debounce_for_test(DEBOUNCE);
    let (tx, mut rx) = mpsc::channel(8);

    core.helm_releases_subscribe(&id, tx, "main").unwrap();

    assert!(matches!(
        next(&mut rx).await,
        Some(HelmReleasesEvent::Failed { .. })
    ));
    assert_eq!(next(&mut rx).await, None);
    core.shutdown().await;
}

#[tokio::test]
async fn unsubscribing_ends_the_watch_without_an_event() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (subscription, mut rx) = watching(&core, &fake, &id).await;

    core.helm_releases_unsubscribe(&subscription);

    assert_eq!(next(&mut rx).await, None);
    // Safe to repeat, and for an id that never existed.
    core.helm_releases_unsubscribe(&subscription);
    core.helm_releases_unsubscribe("helm-999");
    core.shutdown().await;
}

#[tokio::test]
async fn a_window_s_watch_ends_with_it_and_another_window_s_goes_on() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (_kept, mut kept) = watching(&core, &fake, &id).await;
    let (tx, mut ended) = mpsc::channel(8);
    core.helm_releases_subscribe(&id, tx, "window-2").unwrap();
    until_open_watches(&fake, 2).await;

    core.subscriptions_stop_owned("window-2");

    assert_eq!(next(&mut ended).await, None);
    until_open_watches(&fake, 1).await;
    fake.upsert("secrets", release_secret("sh.helm.release.v1.web.v1"));
    assert_eq!(next(&mut kept).await, Some(HelmReleasesEvent::Changed));
    core.shutdown().await;
}

#[tokio::test]
async fn a_disconnect_ends_the_watch_silently() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (_subscription, mut rx) = watching(&core, &fake, &id).await;

    core.cluster_disconnect(&id).await.unwrap();

    assert_eq!(next(&mut rx).await, None);
    core.shutdown().await;
}

#[tokio::test]
async fn a_closed_receiver_ends_the_watch() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (_subscription, rx) = watching(&core, &fake, &id).await;
    drop(rx);

    let started = Instant::now();
    while fake.open_watch_count() > 0 {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the watch outlived its receiver"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    core.shutdown().await;
}

#[tokio::test]
async fn subscribing_needs_a_connected_cluster() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    core.cluster_disconnect(&id).await.unwrap();
    let (tx, _rx) = mpsc::channel(8);

    assert!(core.helm_releases_subscribe(&id, tx, "main").is_err());
    core.shutdown().await;
}
