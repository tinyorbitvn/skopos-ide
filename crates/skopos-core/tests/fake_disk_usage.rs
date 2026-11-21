//! `nodes_disk_usage` and `volumes_usage` against the fake API server's node proxy. Both
//! read each kubelet's stats summary through one shared fetch.

mod support;

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::error::ErrorCode;
use skopos_core::metrics::{NodeDisk, VolumeUsage};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, ProxyReply};
use support::connected_fake;

fn summary(used: Value, capacity: Value, time: &str) -> Value {
    json!({ "node": {
        "nodeName": "n",
        "fs": { "time": time, "usedBytes": used, "capacityBytes": capacity, "availableBytes": 1 },
    } })
}

fn serve(fake: &FakeKube, node: &str, reply: ProxyReply) {
    fake.serve_node_proxy(node, move |request| {
        assert_eq!(request.path, "/stats/summary");
        reply.clone()
    });
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| (*n).to_owned()).collect()
}

#[tokio::test]
async fn summaries_are_read_sorted_and_stamped() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(
        &fake,
        "node-b",
        ProxyReply::json(
            200,
            summary(
                json!(40_000_000_000u64),
                json!(100_000_000_000u64),
                "2026-11-19T10:00:00Z",
            ),
        ),
    );
    serve(
        &fake,
        "node-a",
        ProxyReply::json(200, summary(json!(7), json!(9), "2026-11-19T10:00:30Z")),
    );
    // Duplicates collapse into one request each.
    let snapshot = core
        .nodes_disk_usage(&id, &names(&["node-b", "node-a", "node-b"]))
        .await
        .unwrap();
    assert_eq!(snapshot.timestamp, "2026-11-19T10:00:30Z");
    assert_eq!(
        snapshot.items,
        [
            NodeDisk {
                name: "node-a".into(),
                used_bytes: 7,
                capacity_bytes: 9
            },
            NodeDisk {
                name: "node-b".into(),
                used_bytes: 40_000_000_000,
                capacity_bytes: 100_000_000_000,
            },
        ]
    );
    let json = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(json["items"][1]["usedBytes"], json!(40_000_000_000u64));
    assert_eq!(
        fake.request_count("/api/v1/nodes/node-b/proxy/stats/summary"),
        1
    );
}

#[tokio::test]
async fn no_names_make_no_request() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    let snapshot = core.nodes_disk_usage(&id, &[]).await.unwrap();
    assert!(snapshot.items.is_empty());
    assert!(snapshot
        .timestamp
        .parse::<k8s_openapi::jiff::Timestamp>()
        .is_ok());
    assert_eq!(fake.request_count("/api/v1/nodes/x/proxy/stats/summary"), 0);
}

#[tokio::test]
async fn a_bad_name_fails_before_any_request() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(
        &fake,
        "ok",
        ProxyReply::json(200, summary(json!(1), json!(2), "2026-11-19T10:00:00Z")),
    );
    for bad in ["", "a/b", "..", "a?b", "a%2fb"] {
        let err = core
            .nodes_disk_usage(&id, &names(&["ok", bad]))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{bad:?}");
    }
    assert_eq!(
        fake.request_count("/api/v1/nodes/ok/proxy/stats/summary"),
        0
    );
}

#[tokio::test]
async fn a_node_that_fails_is_left_out() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    let ok = summary(json!(1), json!(2), "2026-11-19T10:00:00Z");
    serve(&fake, "good", ProxyReply::json(200, ok));
    serve(
        &fake,
        "denied",
        ProxyReply::json(403, json!({ "kind": "Status", "code": 403 })),
    );
    serve(&fake, "broken", ProxyReply::json(500, json!({})));
    serve(&fake, "garbage", ProxyReply::text(200, "not json"));
    serve(
        &fake,
        "float",
        ProxyReply::json(200, summary(json!(1.5), json!(2), "2026-11-19T10:00:00Z")),
    );
    serve(
        &fake,
        "partial",
        ProxyReply::json(200, json!({ "node": { "fs": { "usedBytes": 1 } } })),
    );
    // "unserved" has no handler: 404.
    let snapshot = core
        .nodes_disk_usage(
            &id,
            &names(&[
                "good", "denied", "broken", "garbage", "float", "partial", "unserved",
            ]),
        )
        .await
        .unwrap();
    let listed: Vec<_> = snapshot.items.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(listed, ["good"]);
}

#[tokio::test]
async fn forbidden_everywhere_is_forbidden() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(&fake, "a", ProxyReply::json(403, json!({})));
    serve(&fake, "b", ProxyReply::json(403, json!({})));
    let err = core
        .nodes_disk_usage(&id, &names(&["a", "b"]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details.as_deref(), Some("HTTP 403"));
    assert!(err.message.contains("nodes/proxy"));
}

#[tokio::test]
async fn a_deny_rule_on_node_proxy_is_forbidden() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "get".into(),
            plural: "nodes/proxy".into(),
            namespace: None,
        }],
        ..FakeKubeConfig::default()
    };
    let (core, fake, id, _home) = connected_fake(cfg).await;
    serve(
        &fake,
        "a",
        ProxyReply::json(200, summary(json!(1), json!(2), "2026-11-19T10:00:00Z")),
    );
    let err = core
        .nodes_disk_usage(&id, &names(&["a"]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn mixed_failures_give_an_empty_list() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(&fake, "a", ProxyReply::json(403, json!({})));
    let snapshot = core
        .nodes_disk_usage(&id, &names(&["a", "missing"]))
        .await
        .unwrap();
    assert!(snapshot.items.is_empty());
}

#[tokio::test]
async fn a_slow_node_times_out_and_is_left_out() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    let ok = summary(json!(1), json!(2), "2026-11-19T10:00:00Z");
    serve(&fake, "fast", ProxyReply::json(200, ok.clone()));
    serve(
        &fake,
        "slow",
        ProxyReply::json(200, ok).after(Duration::from_secs(10)),
    );
    let started = Instant::now();
    let snapshot = core
        .nodes_disk_usage_within(&id, &names(&["fast", "slow"]), Duration::from_millis(300))
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    let listed: Vec<_> = snapshot.items.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(listed, ["fast"]);
}

#[tokio::test]
async fn an_unreachable_server_is_an_error() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    fake.shutdown().await;
    let err = core
        .nodes_disk_usage(&id, &names(&["a", "b"]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
}

#[tokio::test]
async fn more_nodes_than_the_parallel_limit_are_all_read() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    let list: Vec<String> = (0..20).map(|n| format!("node-{n:02}")).collect();
    for name in &list {
        serve(
            &fake,
            name,
            ProxyReply::json(200, summary(json!(1), json!(2), "2026-11-19T10:00:00Z")),
        );
    }
    let snapshot = core.nodes_disk_usage(&id, &list).await.unwrap();
    let listed: Vec<_> = snapshot.items.iter().map(|d| d.name.clone()).collect();
    assert_eq!(listed, list);
}

/// One volume of a Pod in a kubelet summary, mounting `claim` of `namespace`.
fn claim_volume(namespace: &str, claim: &str, used: u64, capacity: u64) -> Value {
    json!({
        "time": "2026-11-21T10:00:00Z",
        "name": "data",
        "usedBytes": used,
        "capacityBytes": capacity,
        "availableBytes": capacity.saturating_sub(used),
        "inodes": 1000,
        "inodesFree": 900,
        "inodesUsed": 100,
        "pvcRef": { "name": claim, "namespace": namespace },
    })
}

/// A volume that mounts no claim: a Pod's service account token.
fn token_volume() -> Value {
    json!({
        "time": "2026-11-21T10:00:00Z",
        "name": "kube-api-access-x7k2p",
        "usedBytes": 12_288,
        "capacityBytes": 8_318_566_400u64,
    })
}

/// A kubelet summary with one Pod per `(namespace, pod, volumes)`.
fn pods_summary(pods: &[(&str, &str, Vec<Value>)]) -> Value {
    let pods: Vec<Value> = pods
        .iter()
        .map(|(namespace, pod, volumes)| {
            json!({
                "podRef": { "name": pod, "namespace": namespace, "uid": format!("{pod}-uid") },
                "volume": volumes,
            })
        })
        .collect();
    json!({
        "node": {
            "nodeName": "n",
            "fs": { "time": "2026-11-21T10:00:00Z", "usedBytes": 1, "capacityBytes": 2 },
        },
        "pods": pods,
    })
}

fn claim_usage(
    namespace: &str,
    claim: &str,
    node: &str,
    used_bytes: u64,
    capacity_bytes: u64,
) -> VolumeUsage {
    VolumeUsage {
        namespace: namespace.into(),
        claim: claim.into(),
        node: node.into(),
        used_bytes,
        capacity_bytes,
    }
}

#[tokio::test]
async fn mounted_claims_are_read_once_per_node_and_sorted_by_namespace_then_claim() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(
        &fake,
        "node-a",
        ProxyReply::json(
            200,
            pods_summary(&[(
                "shop",
                "db-0",
                vec![
                    claim_volume("shop", "data-db-0", 13_207_024_435, 21_474_836_480),
                    token_volume(),
                ],
            )]),
        ),
    );
    serve(
        &fake,
        "node-b",
        ProxyReply::json(
            200,
            pods_summary(&[
                (
                    "shop",
                    "api-7f9c",
                    vec![claim_volume("shop", "uploads", 1, 2), token_volume()],
                ),
                (
                    "billing",
                    "ledger-0",
                    vec![claim_volume(
                        "billing",
                        "ledger",
                        912_261_120,
                        10_737_418_240,
                    )],
                ),
                ("kube-system", "coredns-1", vec![token_volume()]),
            ]),
        ),
    );
    // Duplicates collapse into one request each.
    let snapshot = core
        .volumes_usage(&id, &names(&["node-b", "node-a", "node-b"]))
        .await
        .unwrap();
    assert_eq!(snapshot.timestamp, "2026-11-21T10:00:00Z");
    assert_eq!(
        snapshot.items,
        [
            claim_usage("billing", "ledger", "node-b", 912_261_120, 10_737_418_240),
            claim_usage(
                "shop",
                "data-db-0",
                "node-a",
                13_207_024_435,
                21_474_836_480
            ),
            claim_usage("shop", "uploads", "node-b", 1, 2),
        ]
    );
    let json = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(json["items"][1]["usedBytes"], json!(13_207_024_435u64));
    assert_eq!(json["items"][1]["capacityBytes"], json!(21_474_836_480u64));
    assert_eq!(
        fake.request_count("/api/v1/nodes/node-b/proxy/stats/summary"),
        1
    );
}

#[tokio::test]
async fn a_claim_on_two_nodes_is_reported_once() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    // A ReadWriteMany claim that Pods on both nodes mount; each kubelet measures it on its own.
    serve(
        &fake,
        "node-a",
        ProxyReply::json(
            200,
            pods_summary(&[(
                "shop",
                "web-1",
                vec![claim_volume("shop", "shared", 300_000_000, 1_073_741_824)],
            )]),
        ),
    );
    serve(
        &fake,
        "node-b",
        ProxyReply::json(
            200,
            pods_summary(&[
                (
                    "shop",
                    "web-2",
                    vec![claim_volume("shop", "shared", 700_000_000, 1_073_741_824)],
                ),
                (
                    "shop",
                    "web-3",
                    vec![claim_volume("shop", "shared", 700_000_000, 1_073_741_824)],
                ),
            ]),
        ),
    );
    let snapshot = core
        .volumes_usage(&id, &names(&["node-a", "node-b"]))
        .await
        .unwrap();
    assert_eq!(
        snapshot.items,
        [claim_usage(
            "shop",
            "shared",
            "node-b",
            700_000_000,
            1_073_741_824
        )]
    );
}

#[tokio::test]
async fn a_node_that_times_out_is_left_out() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(
        &fake,
        "fast",
        ProxyReply::json(
            200,
            pods_summary(&[(
                "shop",
                "web-1",
                vec![
                    claim_volume("shop", "shared", 100, 1000),
                    claim_volume("shop", "fast-data", 5, 10),
                ],
            )]),
        ),
    );
    serve(
        &fake,
        "slow",
        ProxyReply::json(
            200,
            pods_summary(&[(
                "shop",
                "web-2",
                vec![
                    claim_volume("shop", "shared", 900, 1000),
                    claim_volume("shop", "slow-data", 5, 10),
                ],
            )]),
        )
        .after(Duration::from_secs(10)),
    );
    let started = Instant::now();
    let snapshot = core
        .volumes_usage_within(&id, &names(&["fast", "slow"]), Duration::from_millis(300))
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    // Only the slow node's claims are gone: the shared claim keeps what the fast node read.
    assert_eq!(
        snapshot.items,
        [
            claim_usage("shop", "fast-data", "fast", 5, 10),
            claim_usage("shop", "shared", "fast", 100, 1000),
        ]
    );
}

#[tokio::test]
async fn a_node_that_fails_otherwise_adds_no_claim() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(
        &fake,
        "good",
        ProxyReply::json(
            200,
            pods_summary(&[(
                "shop",
                "web-1",
                vec![claim_volume("shop", "good-data", 1, 2)],
            )]),
        ),
    );
    serve(
        &fake,
        "denied",
        ProxyReply::json(403, json!({ "kind": "Status", "code": 403 })),
    );
    serve(&fake, "broken", ProxyReply::json(500, json!({})));
    serve(&fake, "garbage", ProxyReply::text(200, "not json"));
    // "unserved" has no handler: 404.
    let snapshot = core
        .volumes_usage(
            &id,
            &names(&["good", "denied", "broken", "garbage", "unserved"]),
        )
        .await
        .unwrap();
    assert_eq!(
        snapshot.items,
        [claim_usage("shop", "good-data", "good", 1, 2)]
    );
}

#[tokio::test]
async fn a_forbidden_node_proxy_is_the_error_the_disk_read_gives() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(&fake, "a", ProxyReply::json(403, json!({})));
    serve(&fake, "b", ProxyReply::json(403, json!({})));
    let err = core
        .volumes_usage(&id, &names(&["a", "b"]))
        .await
        .unwrap_err();
    let disk = core
        .nodes_disk_usage(&id, &names(&["a", "b"]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details.as_deref(), Some("HTTP 403"));
    assert_eq!((err.code, &err.details), (disk.code, &disk.details));
    assert_eq!(
        err.message,
        "You have no access to nodes/proxy, so the claims' volume stats cannot be read."
    );
}

#[tokio::test]
async fn no_nodes_ask_nothing_and_a_bad_node_name_fails_first() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    serve(
        &fake,
        "ok",
        ProxyReply::json(
            200,
            pods_summary(&[("shop", "web-1", vec![claim_volume("shop", "data", 1, 2)])]),
        ),
    );
    let snapshot = core.volumes_usage(&id, &[]).await.unwrap();
    assert!(snapshot.items.is_empty());
    assert!(snapshot
        .timestamp
        .parse::<k8s_openapi::jiff::Timestamp>()
        .is_ok());
    for bad in ["", "a/b", "..", "a?b", "a%2fb"] {
        let err = core
            .volumes_usage(&id, &names(&["ok", bad]))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{bad:?}");
    }
    assert_eq!(
        fake.request_count("/api/v1/nodes/ok/proxy/stats/summary"),
        0
    );
}

#[tokio::test]
async fn an_unreachable_server_is_an_error_for_the_claims_too() {
    let (core, fake, id, _home) = connected_fake(FakeKubeConfig::default()).await;
    fake.shutdown().await;
    let err = core
        .volumes_usage(&id, &names(&["a", "b"]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
}
