//! The volume stats of mounted claims (`volumes_usage`): what each kubelet's Summary API
//! reports of the PersistentVolumeClaims its Pods mount, read through the API server's node
//! proxy with the fetch the nodes' disk use shares (spec §4.1).

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use k8s_openapi::jiff::Timestamp;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::disk::{read_summaries, usable, NODE_TIMEOUT};
use crate::app_core::AppCore;
use crate::error::CoreResult;
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment};

/// What a read forbidden everywhere could not give.
const VOLUME_STATS: &str = "the claims' volume stats";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VolumeUsage {
    pub namespace: String,
    /// The PersistentVolumeClaim's name.
    pub claim: String,
    /// The node whose kubelet reported these bytes.
    pub node: String,
    #[ts(type = "number")]
    pub used_bytes: u64,
    /// The volume's size as the kubelet sees it, which can differ from the claim's.
    #[ts(type = "number")]
    pub capacity_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VolumeUsageSnapshot {
    /// RFC 3339: when the newest volume was measured, or now when there is none.
    pub timestamp: String,
    /// One per claim, sorted by namespace, then claim. A claim that Pods mount on several
    /// nodes is listed once, with its largest used bytes. A node whose summary could not be
    /// read adds nothing.
    pub items: Vec<VolumeUsage>,
}

/// A volume of a summary that names a claim, and when it was measured.
type Measured = (VolumeUsage, Option<Timestamp>);

/// The volumes of `node`'s stats summary that carry a `pvcRef` (`pods[].volume[]`), each with
/// integer `usedBytes` and `capacityBytes`. `None` when the summary is not JSON.
fn parse_claims(node: &str, body: &[u8]) -> Option<Vec<Measured>> {
    let summary: Value = serde_json::from_slice(body).ok()?;
    let volumes = summary["pods"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|pod| pod["volume"].as_array().into_iter().flatten());
    let mut found = Vec::new();
    for volume in volumes {
        let claim = &volume["pvcRef"];
        let (Some(namespace), Some(name)) = (claim["namespace"].as_str(), claim["name"].as_str())
        else {
            continue;
        };
        let (Some(used_bytes), Some(capacity_bytes)) = (
            volume["usedBytes"].as_u64(),
            volume["capacityBytes"].as_u64(),
        ) else {
            continue;
        };
        let time = volume["time"]
            .as_str()
            .and_then(|t| t.parse::<Timestamp>().ok());
        found.push((
            VolumeUsage {
                namespace: namespace.to_owned(),
                claim: name.to_owned(),
                node: node.to_owned(),
                used_bytes,
                capacity_bytes,
            },
            time,
        ));
    }
    Some(found)
}

/// One item per claim, sorted by namespace, then claim. Of the volumes that name the same
/// claim, the one with the most used bytes stays, the first read on a tie. The newest
/// measurement stamps the snapshot.
fn merge(read: Vec<Vec<Measured>>) -> VolumeUsageSnapshot {
    let mut newest: Option<Timestamp> = None;
    let mut claims: BTreeMap<(String, String), VolumeUsage> = BTreeMap::new();
    for (volume, time) in read.into_iter().flatten() {
        newest = newest.max(time);
        match claims.entry((volume.namespace.clone(), volume.claim.clone())) {
            Entry::Occupied(mut kept) => {
                if volume.used_bytes > kept.get().used_bytes {
                    *kept.get_mut() = volume;
                }
            }
            Entry::Vacant(slot) => {
                slot.insert(volume);
            }
        }
    }
    VolumeUsageSnapshot {
        timestamp: newest.unwrap_or_else(Timestamp::now).to_string(),
        items: claims.into_values().collect(),
    }
}

impl AppCore {
    /// The used and total bytes of each claim that Pods on the named nodes mount, as the
    /// nodes' kubelets report them. Forbidden when every node answered 403, as for the
    /// nodes' disk use.
    pub async fn volumes_usage(
        &self,
        id: &ClusterId,
        nodes: &[String],
    ) -> CoreResult<VolumeUsageSnapshot> {
        self.volumes_usage_within(id, nodes, NODE_TIMEOUT).await
    }

    /// `volumes_usage` with a chosen time limit per node.
    pub async fn volumes_usage_within(
        &self,
        id: &ClusterId,
        nodes: &[String],
        timeout: Duration,
    ) -> CoreResult<VolumeUsageSnapshot> {
        if let Some(name) = nodes.iter().find(|name| !is_path_segment(name)) {
            return Err(invalid(format!("{name:?} is not a node name")));
        }
        let nodes: BTreeSet<String> = nodes.iter().cloned().collect();
        if nodes.is_empty() {
            return Ok(merge(Vec::new()));
        }
        let client = self.cluster_client(id)?;
        let outcomes = read_summaries(client, nodes, timeout, parse_claims).await;
        Ok(merge(usable(outcomes, VOLUME_STATS)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(namespace: &str, claim: &str, node: &str, used_bytes: u64) -> VolumeUsage {
        VolumeUsage {
            namespace: namespace.into(),
            claim: claim.into(),
            node: node.into(),
            used_bytes,
            capacity_bytes: 1_000_000,
        }
    }

    fn at(time: &str) -> Option<Timestamp> {
        Some(time.parse().unwrap())
    }

    #[test]
    fn a_summary_gives_the_claims_its_pods_mount_and_drops_other_volumes() {
        let body = br#"{"node":{"nodeName":"node-a","fs":{"usedBytes":1,"capacityBytes":2}},
            "pods":[
              {"podRef":{"name":"db-0","namespace":"shop"},"volume":[
                {"time":"2026-11-21T10:00:00Z","name":"data","usedBytes":13207024435,
                 "capacityBytes":21474836480,"availableBytes":8267812045,
                 "pvcRef":{"name":"data-db-0","namespace":"shop"}},
                {"time":"2026-11-21T10:00:00Z","name":"kube-api-access-x7k2p",
                 "usedBytes":12288,"capacityBytes":8318566400}
              ]},
              {"podRef":{"name":"web-1","namespace":"shop"}},
              {"podRef":{"name":"ledger-0","namespace":"billing"},"volume":[
                {"time":"yesterday","name":"ledger","usedBytes":912261120,
                 "capacityBytes":10737418240,"pvcRef":{"name":"ledger","namespace":"billing"}},
                {"name":"scratch","usedBytes":4096,"capacityBytes":8318566400}
              ]}
            ]}"#;
        let found = parse_claims("node-a", body).unwrap();
        assert_eq!(
            found,
            [
                (
                    VolumeUsage {
                        namespace: "shop".into(),
                        claim: "data-db-0".into(),
                        node: "node-a".into(),
                        used_bytes: 13_207_024_435,
                        capacity_bytes: 21_474_836_480,
                    },
                    at("2026-11-21T10:00:00Z"),
                ),
                (
                    VolumeUsage {
                        namespace: "billing".into(),
                        claim: "ledger".into(),
                        node: "node-a".into(),
                        used_bytes: 912_261_120,
                        capacity_bytes: 10_737_418_240,
                    },
                    None,
                ),
            ]
        );
    }

    #[test]
    fn a_claim_volume_without_integer_sizes_or_a_whole_claim_ref_is_left_out() {
        for volume in [
            r#"{"name":"a","capacityBytes":10,"pvcRef":{"name":"a","namespace":"shop"}}"#,
            r#"{"name":"a","usedBytes":1,"pvcRef":{"name":"a","namespace":"shop"}}"#,
            r#"{"name":"a","usedBytes":1.5,"capacityBytes":10,"pvcRef":{"name":"a","namespace":"shop"}}"#,
            r#"{"name":"a","usedBytes":"1","capacityBytes":10,"pvcRef":{"name":"a","namespace":"shop"}}"#,
            r#"{"name":"a","usedBytes":-1,"capacityBytes":10,"pvcRef":{"name":"a","namespace":"shop"}}"#,
            r#"{"name":"a","usedBytes":1,"capacityBytes":10,"pvcRef":{"name":"a"}}"#,
            r#"{"name":"a","usedBytes":1,"capacityBytes":10,"pvcRef":{"namespace":"shop"}}"#,
            r#"{"name":"a","usedBytes":1,"capacityBytes":10,"pvcRef":"a"}"#,
            r#""not a volume""#,
        ] {
            let body = format!(r#"{{"pods":[{{"volume":[{volume}]}}]}}"#);
            assert_eq!(
                parse_claims("n", body.as_bytes()),
                Some(Vec::new()),
                "{volume}"
            );
        }
    }

    #[test]
    fn a_summary_that_is_not_json_is_unusable_and_one_without_pods_has_no_claims() {
        for body in ["not json", ""] {
            assert!(parse_claims("n", body.as_bytes()).is_none(), "{body:?}");
        }
        for body in [
            "{}",
            r#"{"pods":[]}"#,
            r#"{"pods":3}"#,
            r#"{"pods":[{"volume":"x"}, 7]}"#,
        ] {
            assert_eq!(
                parse_claims("n", body.as_bytes()),
                Some(Vec::new()),
                "{body}"
            );
        }
    }

    #[test]
    fn a_claim_seen_on_several_nodes_keeps_its_largest_used_bytes() {
        let snapshot = merge(vec![
            vec![
                (
                    usage("shop", "shared", "node-a", 300),
                    at("2026-11-21T10:00:00Z"),
                ),
                (usage("shop", "data-db-0", "node-a", 50), None),
            ],
            vec![
                (
                    usage("shop", "shared", "node-b", 700),
                    at("2026-11-21T10:00:30Z"),
                ),
                (usage("billing", "ledger", "node-b", 10), None),
            ],
            vec![(usage("shop", "shared", "node-c", 500), None)],
        ]);
        assert_eq!(
            snapshot.items,
            [
                usage("billing", "ledger", "node-b", 10),
                usage("shop", "data-db-0", "node-a", 50),
                usage("shop", "shared", "node-b", 700),
            ]
        );
        assert_eq!(snapshot.timestamp, "2026-11-21T10:00:30Z");
    }

    #[test]
    fn on_a_tie_the_first_node_read_stays_and_nothing_read_is_stamped_now() {
        let snapshot = merge(vec![
            vec![(usage("shop", "shared", "node-a", 300), None)],
            vec![(usage("shop", "shared", "node-b", 300), None)],
        ]);
        assert_eq!(snapshot.items, [usage("shop", "shared", "node-a", 300)]);
        assert!(snapshot.timestamp.parse::<Timestamp>().is_ok());
        let empty = merge(Vec::new());
        assert!(empty.items.is_empty());
        assert!(empty.timestamp.parse::<Timestamp>().is_ok());
    }

    #[test]
    fn an_item_crosses_in_camel_case() {
        let json = serde_json::to_value(usage("shop", "data", "node-a", 5)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "namespace": "shop",
                "claim": "data",
                "node": "node-a",
                "usedBytes": 5,
                "capacityBytes": 1_000_000,
            })
        );
    }
}
