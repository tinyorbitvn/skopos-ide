//! `nodes_disk_usage` against the fake API server's node proxy.

mod support;

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::error::ErrorCode;
use skopos_core::metrics::NodeDisk;
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
