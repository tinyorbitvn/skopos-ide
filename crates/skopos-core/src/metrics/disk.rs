//! Root filesystem use per node (`nodes_disk_usage`), from the kubelet's Summary API behind
//! the API server's node proxy.

use std::collections::BTreeSet;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use k8s_openapi::jiff::Timestamp;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::app_core::AppCore;
use crate::cluster::get_raw;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment};

/// How many kubelets are asked at once.
const PARALLEL_NODES: usize = 8;
/// How long one kubelet may take.
const NODE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NodeDisk {
    pub name: String,
    #[ts(type = "number")]
    pub used_bytes: u64,
    #[ts(type = "number")]
    pub capacity_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NodeDiskSnapshot {
    /// RFC 3339: when the newest node was measured, or now when there is none.
    pub timestamp: String,
    /// Sorted by name. A node whose summary could not be read is not listed.
    pub items: Vec<NodeDisk>,
}

enum NodeOutcome {
    Read(NodeDisk, Option<Timestamp>),
    Forbidden,
    /// The API server could not be reached.
    Transport(IpcError),
    /// Any other way of not getting a usable summary.
    Failed,
}

/// `.node.fs`'s `usedBytes` and `capacityBytes` (integers) and `time`, from a stats summary.
pub(crate) fn parse_summary(name: &str, body: &[u8]) -> Option<(NodeDisk, Option<Timestamp>)> {
    let summary: Value = serde_json::from_slice(body).ok()?;
    let fs = &summary["node"]["fs"];
    let disk = NodeDisk {
        name: name.to_owned(),
        used_bytes: fs["usedBytes"].as_u64()?,
        capacity_bytes: fs["capacityBytes"].as_u64()?,
    };
    let time = fs["time"]
        .as_str()
        .and_then(|t| t.parse::<Timestamp>().ok());
    Some((disk, time))
}

async fn read_node(client: &kube::Client, name: &str, timeout: Duration) -> NodeOutcome {
    let path = format!("/api/v1/nodes/{name}/proxy/stats/summary");
    match tokio::time::timeout(timeout, get_raw(client, &path)).await {
        Err(_elapsed) => NodeOutcome::Failed,
        Ok(Err(err)) => NodeOutcome::Transport(err),
        Ok(Ok(raw)) if raw.status.as_u16() == 403 => NodeOutcome::Forbidden,
        Ok(Ok(raw)) if raw.status.is_success() => match parse_summary(name, &raw.body) {
            Some((disk, time)) => NodeOutcome::Read(disk, time),
            None => NodeOutcome::Failed,
        },
        Ok(Ok(_)) => NodeOutcome::Failed,
    }
}

/// The snapshot from every node's outcome, or the one error that explains having nothing:
/// 403 everywhere, or an API server that cannot be reached. Outcomes arrive in name order.
fn conclude(outcomes: Vec<NodeOutcome>) -> CoreResult<NodeDiskSnapshot> {
    let total = outcomes.len();
    let mut items = Vec::new();
    let mut newest: Option<Timestamp> = None;
    let mut forbidden = 0;
    let mut first_transport: Option<IpcError> = None;
    let mut transport = 0;
    for outcome in outcomes {
        match outcome {
            NodeOutcome::Read(disk, time) => {
                newest = newest.max(time);
                items.push(disk);
            }
            NodeOutcome::Forbidden => forbidden += 1,
            NodeOutcome::Transport(err) => {
                transport += 1;
                first_transport.get_or_insert(err);
            }
            NodeOutcome::Failed => {}
        }
    }
    if items.is_empty() && total > 0 {
        if forbidden == total {
            return Err(IpcError::new(
                ErrorCode::Forbidden,
                "You have no access to nodes/proxy, so the nodes' disk use cannot be read.",
            )
            .with_details("HTTP 403"));
        }
        if let (true, Some(err)) = (transport == total, first_transport) {
            return Err(err);
        }
    }
    Ok(NodeDiskSnapshot {
        timestamp: newest.unwrap_or_else(Timestamp::now).to_string(),
        items,
    })
}

impl AppCore {
    /// The root filesystem use of each named node, as its kubelet reports it.
    pub async fn nodes_disk_usage(
        &self,
        id: &ClusterId,
        names: &[String],
    ) -> CoreResult<NodeDiskSnapshot> {
        self.nodes_disk_usage_within(id, names, NODE_TIMEOUT).await
    }

    /// `nodes_disk_usage` with a chosen time limit per node.
    pub async fn nodes_disk_usage_within(
        &self,
        id: &ClusterId,
        names: &[String],
        timeout: Duration,
    ) -> CoreResult<NodeDiskSnapshot> {
        if let Some(name) = names.iter().find(|name| !is_path_segment(name)) {
            return Err(invalid(format!("{name:?} is not a node name")));
        }
        let names: BTreeSet<String> = names.iter().cloned().collect();
        if names.is_empty() {
            return Ok(NodeDiskSnapshot {
                timestamp: Timestamp::now().to_string(),
                items: Vec::new(),
            });
        }
        let client = self.cluster_client(id)?;
        // Owned, so the futures do not borrow from this one: tauri needs them `Send` for any lifetime.
        let mut outcomes: Vec<(String, NodeOutcome)> = stream::iter(names)
            .map(|name| {
                let client = client.clone();
                async move {
                    let outcome = read_node(&client, &name, timeout).await;
                    (name, outcome)
                }
            })
            .buffer_unordered(PARALLEL_NODES)
            .collect()
            .await;
        outcomes.sort_by(|a, b| a.0.cmp(&b.0));
        conclude(outcomes.into_iter().map(|(_, outcome)| outcome).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(name: &str) -> NodeDisk {
        NodeDisk {
            name: name.to_owned(),
            used_bytes: 1,
            capacity_bytes: 2,
        }
    }

    #[test]
    fn a_summary_gives_the_root_filesystem() {
        let body = br#"{"node":{"nodeName":"n","fs":{"time":"2026-11-19T10:00:00Z",
            "availableBytes":5,"capacityBytes":100000000000,"usedBytes":40000000000},
            "runtime":{"imageFs":{"usedBytes":9,"capacityBytes":9}}}}"#;
        let (found, time) = parse_summary("n", body).unwrap();
        assert_eq!(
            found,
            NodeDisk {
                name: "n".into(),
                used_bytes: 40_000_000_000,
                capacity_bytes: 100_000_000_000,
            }
        );
        assert_eq!(time, "2026-11-19T10:00:00Z".parse().ok());
    }

    #[test]
    fn a_summary_without_integer_sizes_is_unusable() {
        for body in [
            r#"{"node":{"fs":{"capacityBytes":10}}}"#,
            r#"{"node":{"fs":{"usedBytes":10}}}"#,
            r#"{"node":{"fs":{"usedBytes":"10","capacityBytes":10}}}"#,
            r#"{"node":{"fs":{"usedBytes":1.5,"capacityBytes":10}}}"#,
            r#"{"node":{"fs":{"usedBytes":-1,"capacityBytes":10}}}"#,
            r#"{"node":{"fs":{"usedBytes":null,"capacityBytes":10}}}"#,
            r#"{"node":{}}"#,
            r#"{}"#,
            "not json",
            "",
        ] {
            assert!(parse_summary("n", body.as_bytes()).is_none(), "{body}");
        }
    }

    #[test]
    fn a_missing_or_bad_time_does_not_spoil_the_sizes() {
        for body in [
            r#"{"node":{"fs":{"usedBytes":1,"capacityBytes":2}}}"#,
            r#"{"node":{"fs":{"usedBytes":1,"capacityBytes":2,"time":"yesterday"}}}"#,
        ] {
            let (found, time) = parse_summary("n", body.as_bytes()).unwrap();
            assert_eq!(found, disk("n"));
            assert_eq!(time, None);
        }
    }

    #[test]
    fn the_newest_measurement_stamps_the_snapshot() {
        let at = |t: &str| Some(t.parse::<Timestamp>().unwrap());
        let snapshot = conclude(vec![
            NodeOutcome::Read(disk("a"), at("2026-11-19T10:00:00Z")),
            NodeOutcome::Read(disk("b"), at("2026-11-19T10:00:05.500Z")),
            NodeOutcome::Read(disk("c"), None),
            NodeOutcome::Failed,
        ])
        .unwrap();
        assert_eq!(snapshot.timestamp, "2026-11-19T10:00:05.5Z");
        let names: Vec<_> = snapshot.items.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c"]);
        let none = conclude(vec![NodeOutcome::Read(disk("a"), None)]).unwrap();
        assert!(none.timestamp.parse::<Timestamp>().is_ok());
    }

    #[test]
    fn all_forbidden_is_an_error_but_mixed_failures_are_not() {
        let err = conclude(vec![NodeOutcome::Forbidden, NodeOutcome::Forbidden]).unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
        assert_eq!(err.details.as_deref(), Some("HTTP 403"));
        assert!(err.message.contains("nodes/proxy"));
        let mixed = conclude(vec![NodeOutcome::Forbidden, NodeOutcome::Failed]).unwrap();
        assert!(mixed.items.is_empty());
        let partial = conclude(vec![
            NodeOutcome::Forbidden,
            NodeOutcome::Read(disk("a"), None),
        ]);
        assert_eq!(partial.unwrap().items.len(), 1);
    }

    #[test]
    fn only_transport_errors_everywhere_give_the_first_error() {
        let unreachable =
            |text: &str| NodeOutcome::Transport(IpcError::new(ErrorCode::Unreachable, text));
        let err = conclude(vec![unreachable("first"), unreachable("second")]).unwrap_err();
        assert_eq!(
            (err.code, err.message.as_str()),
            (ErrorCode::Unreachable, "first")
        );
        let mixed = conclude(vec![unreachable("first"), NodeOutcome::Failed]).unwrap();
        assert!(mixed.items.is_empty());
        assert!(conclude(Vec::new()).unwrap().items.is_empty());
    }
}
