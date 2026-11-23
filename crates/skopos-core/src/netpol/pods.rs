//! What policies read of a Pod and a Namespace (spec §4.1, §4.2, §5.1): labels, service
//! account, container ports, controller and phase, from a graph-shaped Pod row (contract C8).
//! Read leniently: a field of an unexpected type counts as absent, and nothing here panics.

use std::collections::BTreeMap;

use serde_json::Value;

use super::model::Protocol;

/// Cilium's virtual label for a Pod's namespace (spec §4.1).
pub(crate) const NAMESPACE_LABEL: &str = "io.kubernetes.pod.namespace";
/// Cilium's virtual label for a Pod's service account.
const SERVICE_ACCOUNT_LABEL: &str = "io.cilium.k8s.policy.serviceaccount";
/// Cilium's prefix for the labels of a Pod's namespace.
const NAMESPACE_LABELS_PREFIX: &str = "io.cilium.k8s.namespace.labels.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ContainerPort {
    pub name: Option<String>,
    pub port: u16,
    pub protocol: Protocol,
}

/// From a graph-shaped Pod row (Task 5). `service_account` is "default" when unset. `owner` is
/// the controller owner reference (kind, name). `finished`: phase Succeeded or Failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PodInfo {
    pub namespace: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub service_account: String,
    pub ports: Vec<ContainerPort>,
    pub owner: Option<(String, String)>,
    pub finished: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NamespaceInfo {
    pub name: String,
    pub labels: BTreeMap<String, String>,
}

/// A string at `pointer` that is not empty.
fn text(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The array at `pointer`, or nothing.
fn items<'a>(value: &'a Value, pointer: &str) -> &'a [Value] {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// A map of strings, such as labels. Entries whose value is not a string are left out.
fn string_map(value: &Value) -> BTreeMap<String, String> {
    value.as_object().map_or_else(BTreeMap::new, |map| {
        map.iter()
            .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect()
    })
}

/// A container port: `containerPort` from 1 to 65535, `protocol` TCP when absent. A port of
/// another protocol, or with a number out of range, is left out.
fn container_port(port: &Value) -> Option<ContainerPort> {
    let number = port["containerPort"]
        .as_u64()
        .and_then(|number| u16::try_from(number).ok())
        .filter(|number| *number > 0)?;
    let protocol = match port["protocol"].as_str() {
        None | Some("TCP") => Protocol::Tcp,
        Some("UDP") => Protocol::Udp,
        Some("SCTP") => Protocol::Sctp,
        Some(_) => return None,
    };
    Some(ContainerPort {
        name: text(port, "/name"),
        port: number,
        protocol,
    })
}

/// The Pod of a graph Pod row, or `None` when it has no name.
pub(crate) fn pod_info(object: &Value) -> Option<PodInfo> {
    let metadata = &object["metadata"];
    let name = text(metadata, "/name")?;
    let ports = items(object, "/spec/containers")
        .iter()
        .chain(items(object, "/spec/initContainers"))
        .flat_map(|container| items(container, "/ports"))
        .filter_map(container_port)
        .collect();
    let owner = items(metadata, "/ownerReferences")
        .iter()
        .find(|owner| owner["controller"] == true)
        .and_then(|owner| Some((text(owner, "/kind")?, text(owner, "/name")?)));
    let phase = text(object, "/status/phase");
    Some(PodInfo {
        namespace: text(metadata, "/namespace").unwrap_or_default(),
        name,
        labels: string_map(&metadata["labels"]),
        service_account: text(object, "/spec/serviceAccountName")
            .unwrap_or_else(|| "default".to_owned()),
        ports,
        owner,
        finished: matches!(phase.as_deref(), Some("Succeeded" | "Failed")),
    })
}

/// The Namespace of a listed object, or `None` when it has no name.
pub(crate) fn namespace_info(object: &Value) -> Option<NamespaceInfo> {
    let metadata = &object["metadata"];
    Some(NamespaceInfo {
        name: text(metadata, "/name")?,
        labels: string_map(&metadata["labels"]),
    })
}

impl PodInfo {
    /// Its labels plus `io.kubernetes.pod.namespace`, `io.cilium.k8s.policy.serviceaccount`
    /// and `io.cilium.k8s.namespace.labels.<key>` for each label of its namespace.
    pub(crate) fn cilium_labels(
        &self,
        namespace: Option<&NamespaceInfo>,
    ) -> BTreeMap<String, String> {
        let mut labels = self.labels.clone();
        labels.insert(NAMESPACE_LABEL.to_owned(), self.namespace.clone());
        labels.insert(
            SERVICE_ACCOUNT_LABEL.to_owned(),
            self.service_account.clone(),
        );
        for (key, value) in namespace
            .map(|namespace| &namespace.labels)
            .into_iter()
            .flatten()
        {
            labels.insert(format!("{NAMESPACE_LABELS_PREFIX}{key}"), value.clone());
        }
        labels
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn a_pod_row_gives_its_labels_account_ports_owner_and_phase() {
        let pod = pod_info(&json!({
            "metadata": {
                "name": "api-5c8b-a",
                "namespace": "payments",
                "labels": { "app": "api", "tier": "backend" },
                "ownerReferences": [
                    { "kind": "Other", "name": "x" },
                    { "kind": "ReplicaSet", "name": "api-5c8b", "controller": true },
                ],
            },
            "spec": {
                "serviceAccountName": "api",
                "initContainers": [{ "name": "proxy", "ports": [{ "containerPort": 15001 }] }],
                "containers": [{
                    "name": "app",
                    "ports": [
                        { "name": "http", "containerPort": 8080, "protocol": "TCP" },
                        { "name": "dns", "containerPort": 53, "protocol": "UDP" },
                        { "containerPort": 9090, "protocol": "SCTP" },
                    ],
                }],
            },
            "status": { "phase": "Running" },
        }))
        .unwrap();
        assert_eq!(
            pod,
            PodInfo {
                namespace: "payments".into(),
                name: "api-5c8b-a".into(),
                labels: labels(&[("app", "api"), ("tier", "backend")]),
                service_account: "api".into(),
                ports: vec![
                    ContainerPort {
                        name: Some("http".into()),
                        port: 8080,
                        protocol: Protocol::Tcp
                    },
                    ContainerPort {
                        name: Some("dns".into()),
                        port: 53,
                        protocol: Protocol::Udp
                    },
                    ContainerPort {
                        name: None,
                        port: 9090,
                        protocol: Protocol::Sctp
                    },
                    ContainerPort {
                        name: None,
                        port: 15001,
                        protocol: Protocol::Tcp
                    },
                ],
                owner: Some(("ReplicaSet".into(), "api-5c8b".into())),
                finished: false,
            }
        );
    }

    #[test]
    fn a_pod_without_an_account_uses_default_and_finished_phases_are_finished() {
        for (phase, finished) in [
            (json!("Succeeded"), true),
            (json!("Failed"), true),
            (json!("Running"), false),
            (json!("Pending"), false),
            (json!(null), false),
        ] {
            let pod = pod_info(&json!({
                "metadata": { "name": "job-1", "namespace": "a" },
                "status": { "phase": phase },
            }))
            .unwrap();
            assert_eq!(pod.service_account, "default");
            assert_eq!(pod.finished, finished, "{phase}");
            assert_eq!(pod.owner, None);
        }
    }

    /// Review Focus 3: fields of an unexpected type count as absent, and nothing panics.
    #[test]
    fn odd_pod_fields_are_read_as_absent() {
        let pod = pod_info(&json!({
            "metadata": {
                "name": "odd", "namespace": 5, "labels": "app=web",
                "ownerReferences": { "kind": "ReplicaSet" },
            },
            "spec": {
                "serviceAccountName": 3,
                "initContainers": "proxy",
                "containers": [
                    7,
                    { "ports": "http" },
                    { "ports": [
                        1,
                        { "name": "a", "containerPort": "80" },
                        { "name": "b", "containerPort": 70000 },
                        { "name": "c", "containerPort": 0 },
                        { "name": "d", "containerPort": 81, "protocol": "ICMP" },
                        { "name": 4, "containerPort": 82, "protocol": 6 },
                    ] },
                ],
            },
            "status": { "phase": ["Failed"] },
        }))
        .unwrap();
        assert_eq!(
            pod,
            PodInfo {
                namespace: String::new(),
                name: "odd".into(),
                labels: BTreeMap::new(),
                service_account: "default".into(),
                ports: vec![ContainerPort {
                    name: None,
                    port: 82,
                    protocol: Protocol::Tcp
                }],
                owner: None,
                finished: false,
            }
        );
        assert_eq!(pod_info(&json!({ "metadata": { "name": 5 } })), None);
        assert_eq!(pod_info(&json!(null)), None);
        assert_eq!(namespace_info(&json!({ "metadata": {} })), None);
    }

    #[test]
    fn a_namespace_gives_its_name_and_labels() {
        let namespace = namespace_info(&json!({
            "metadata": {
                "name": "payments",
                "labels": { "kubernetes.io/metadata.name": "payments", "team": "a", "odd": 1 },
            },
        }))
        .unwrap();
        assert_eq!(
            namespace,
            NamespaceInfo {
                name: "payments".into(),
                labels: labels(&[("kubernetes.io/metadata.name", "payments"), ("team", "a")]),
            }
        );
    }

    /// Spec §4.1: Cilium sees a Pod's namespace, service account and namespace labels as labels.
    #[test]
    fn cilium_labels_add_the_virtual_labels() {
        let pod = PodInfo {
            namespace: "payments".into(),
            name: "api-1".into(),
            labels: labels(&[("app", "api")]),
            service_account: "api".into(),
            ports: Vec::new(),
            owner: None,
            finished: false,
        };
        let namespace = NamespaceInfo {
            name: "payments".into(),
            labels: labels(&[("team", "a")]),
        };
        assert_eq!(
            pod.cilium_labels(Some(&namespace)),
            labels(&[
                ("app", "api"),
                ("io.cilium.k8s.namespace.labels.team", "a"),
                ("io.cilium.k8s.policy.serviceaccount", "api"),
                ("io.kubernetes.pod.namespace", "payments"),
            ])
        );
        assert_eq!(
            pod.cilium_labels(None),
            labels(&[
                ("app", "api"),
                ("io.cilium.k8s.policy.serviceaccount", "api"),
                ("io.kubernetes.pod.namespace", "payments"),
            ])
        );
    }
}
