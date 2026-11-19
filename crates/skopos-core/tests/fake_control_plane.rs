//! `cluster_control_plane` against the fake API server.

mod support;

use k8s_openapi::jiff::{SignedDuration, Timestamp};
use serde_json::{json, Value};
use skopos_core::cluster::{ControlPlane, HealthState, PodCounts};
use skopos_core::error::ErrorCode;
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use support::connected_fake;

fn pod(name: &str, labels: Value, ready: bool) -> Value {
    json!({
        "metadata": { "namespace": "kube-system", "name": name, "labels": labels },
        "spec": {},
        "status": { "conditions": [
            { "type": "Ready", "status": if ready { "True" } else { "False" } },
        ] },
    })
}

fn static_pods(fake: &FakeKube) {
    for (name, component) in [
        ("etcd-node", "etcd"),
        ("kube-scheduler-node", "kube-scheduler"),
        ("kube-controller-manager-node", "kube-controller-manager"),
    ] {
        fake.upsert("pods", pod(name, json!({ "component": component }), true));
    }
}

fn serve_leases(fake: &FakeKube) {
    fake.serve_resource(FakeResource::new(
        "coordination.k8s.io",
        "v1",
        "Lease",
        "leases",
        true,
    ));
}

fn serve_apps(fake: &FakeKube) {
    fake.serve_resource(FakeResource::new(
        "apps",
        "v1",
        "DaemonSet",
        "daemonsets",
        true,
    ));
}

fn lease(name: &str, renewed: Timestamp) -> Value {
    json!({
        "metadata": { "namespace": "kube-system", "name": name },
        "spec": {
            "holderIdentity": format!("{name}-holder"),
            "renewTime": renewed.to_string(),
            "leaseDurationSeconds": 15,
        },
    })
}

fn healthy_cluster(fake: &FakeKube) {
    static_pods(fake);
    serve_leases(fake);
    serve_apps(fake);
    for name in ["kube-scheduler", "kube-controller-manager"] {
        fake.upsert("leases", lease(name, Timestamp::now()));
    }
    fake.upsert(
        "deployments",
        json!({
            "metadata": { "namespace": "kube-system", "name": "coredns" },
            "spec": { "replicas": 2 },
            "status": { "readyReplicas": 2 },
        }),
    );
    fake.upsert(
        "daemonsets",
        json!({
            "metadata": { "namespace": "kube-system", "name": "kube-proxy" },
            "status": { "numberReady": 3, "desiredNumberScheduled": 3 },
        }),
    );
}

fn component<'a>(
    plane: &'a ControlPlane,
    id: &str,
) -> &'a skopos_core::cluster::ControlPlaneComponent {
    plane.components.iter().find(|c| c.id == id).unwrap()
}

#[tokio::test]
async fn everything_is_healthy_when_all_sources_are() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    healthy_cluster(&fake);
    let plane = core.cluster_control_plane(&id).await.unwrap();

    let api = &plane.api_server;
    assert_eq!(api.url, fake.url());
    assert_eq!(api.version, "v1.37.0");
    assert_eq!(api.platform.as_deref(), Some("linux/amd64"));
    assert_eq!(api.go_version.as_deref(), Some("go1.25"));
    assert_eq!(api.build_date.as_deref(), Some("2026-01-01T00:00:00Z"));
    assert_eq!(
        (api.live, api.ready),
        (HealthState::Healthy, HealthState::Healthy)
    );
    let names: Vec<_> = api.checks.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["ping", "log", "etcd", "informer-sync"]);
    assert!(api.checks.iter().all(|c| c.ok));

    let ids: Vec<_> = plane.components.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        ["etcd", "scheduler", "controller-manager", "dns", "proxy"]
    );
    assert!(plane
        .components
        .iter()
        .all(|c| c.state == HealthState::Healthy));
    assert_eq!(component(&plane, "etcd").check, Some(true));
    assert_eq!(
        component(&plane, "etcd").pods,
        Some(PodCounts { ready: 1, total: 1 })
    );
    let leader = component(&plane, "scheduler").leader.clone().unwrap();
    assert_eq!(leader.holder, "kube-scheduler-holder");
    assert_eq!(leader.lease_seconds, Some(15));
    assert!(leader.renewed.is_some());
    assert_eq!(
        component(&plane, "dns").pods,
        Some(PodCounts { ready: 2, total: 2 })
    );
    assert_eq!(
        component(&plane, "proxy").pods,
        Some(PodCounts { ready: 3, total: 3 })
    );
}

#[tokio::test]
async fn a_failed_etcd_check_makes_etcd_unhealthy() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    healthy_cluster(&fake);
    fake.set_readyz_status(500);
    fake.set_readyz_checks(&[("ping", true), ("etcd", false), ("etcd-readiness", true)]);
    let plane = core.cluster_control_plane(&id).await.unwrap();

    assert_eq!(plane.api_server.ready, HealthState::Unhealthy);
    assert_eq!(plane.api_server.live, HealthState::Healthy);
    let checks: Vec<_> = plane
        .api_server
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.ok))
        .collect();
    assert_eq!(
        checks,
        [("ping", true), ("etcd", false), ("etcd-readiness", true)]
    );
    let etcd = component(&plane, "etcd");
    assert_eq!(
        (etcd.state, etcd.check),
        (HealthState::Unhealthy, Some(false))
    );
    assert_eq!(component(&plane, "scheduler").state, HealthState::Healthy);
}

#[tokio::test]
async fn forbidden_leases_leave_no_leader() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "get".into(),
            plural: "leases".into(),
            namespace: None,
        }],
        ..FakeKubeConfig::default()
    };
    let (core, fake, id, _home) = connected_fake(cfg).await;
    healthy_cluster(&fake);
    let plane = core.cluster_control_plane(&id).await.unwrap();
    for name in ["scheduler", "controller-manager"] {
        let c = component(&plane, name);
        assert_eq!(c.leader, None, "{name}");
        // The Pods are still seen.
        assert_eq!(c.state, HealthState::Healthy, "{name}");
        assert!(c.pods.is_some(), "{name}");
    }
}

#[tokio::test]
async fn without_daemon_sets_there_is_no_proxy_component() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    static_pods(&fake);
    let plane = core.cluster_control_plane(&id).await.unwrap();
    assert!(plane.components.iter().all(|c| c.id != "proxy"));
    assert_eq!(plane.components.len(), 4);
    // Nothing of DNS or the Leases is seen on this cluster.
    assert_eq!(component(&plane, "dns").state, HealthState::Unknown);
    assert_eq!(component(&plane, "dns").pods, None);
}

#[tokio::test]
async fn a_forbidden_daemon_set_keeps_proxy_unknown() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "get".into(),
            plural: "daemonsets".into(),
            namespace: None,
        }],
        ..FakeKubeConfig::default()
    };
    let (core, fake, id, _home) = connected_fake(cfg).await;
    healthy_cluster(&fake);
    let plane = core.cluster_control_plane(&id).await.unwrap();
    let proxy = component(&plane, "proxy");
    assert_eq!((proxy.state, proxy.pods), (HealthState::Unknown, None));
}

#[tokio::test]
async fn a_forbidden_livez_is_unknown() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    healthy_cluster(&fake);
    fake.set_livez_status(403);
    fake.set_readyz_status(403);
    let plane = core.cluster_control_plane(&id).await.unwrap();
    assert_eq!(plane.api_server.live, HealthState::Unknown);
    assert_eq!(plane.api_server.ready, HealthState::Unknown);
    assert!(plane.api_server.checks.is_empty());
    assert_eq!(component(&plane, "etcd").check, None);
    // The Pods still say something about etcd.
    assert_eq!(component(&plane, "etcd").state, HealthState::Healthy);
}

#[tokio::test]
async fn a_stale_lease_is_an_unhealthy_leader() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    healthy_cluster(&fake);
    let stale = Timestamp::now() - SignedDuration::from_secs(120);
    fake.upsert("leases", lease("kube-scheduler", stale));
    let plane = core.cluster_control_plane(&id).await.unwrap();
    let scheduler = component(&plane, "scheduler");
    assert_eq!(scheduler.state, HealthState::Unhealthy);
    assert_eq!(
        scheduler.leader.as_ref().unwrap().holder,
        "kube-scheduler-holder"
    );
    assert_eq!(
        component(&plane, "controller-manager").state,
        HealthState::Healthy
    );
}

#[tokio::test]
async fn dns_prefers_the_kube_dns_label_over_the_coredns_name() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    healthy_cluster(&fake);
    fake.upsert(
        "deployments",
        json!({
            "metadata": { "namespace": "kube-system", "name": "dns-a", "labels": { "k8s-app": "kube-dns" } },
            "spec": { "replicas": 2 },
            "status": { "readyReplicas": 1 },
        }),
    );
    let plane = core.cluster_control_plane(&id).await.unwrap();
    let dns = component(&plane, "dns");
    assert_eq!(dns.pods, Some(PodCounts { ready: 1, total: 2 }));
    assert_eq!(dns.state, HealthState::Degraded);
}

#[tokio::test]
async fn an_unreachable_server_fails_the_call() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    fake.shutdown().await;
    let err = core.cluster_control_plane(&id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
}

#[tokio::test]
async fn a_cluster_that_is_not_connected_is_an_error() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    core.cluster_disconnect(&id).await.unwrap();
    assert!(core.cluster_control_plane(&id).await.is_err());
    drop(fake);
}
