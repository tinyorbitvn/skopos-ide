//! What a watched row keeps of its object. A table holds every row of a resource, and the
//! webview's memory grows with what each row carries. So a row of a core Pod, Node or
//! ConfigMap, of an apps ReplicaSet or of a CustomResourceDefinition keeps only what the UI
//! reads outside the detail drawer, which fetches the whole object with `resource_get`.
//! Annotations stay for the list's filter, each value cut short (spec M24), and so does a
//! Pod's status message for the workload Status card, cut the same way (spec N20). The
//! resource graph reads these same rows for every kind but Pods, so each rule keeps what the
//! graph's extractors read too.

use serde_json::Value;

use super::types::ResourceRef;

/// What one JSON value keeps.
enum Keep {
    /// The value as it is.
    All,
    /// An object keeps these fields only, each under its own rule.
    Fields(&'static [(&'static str, Keep)]),
    /// An array's items each follow the rule.
    Each(&'static Keep),
    /// An object's string values, each cut to its first this many characters on a `char`
    /// boundary. A value that is not a string is dropped.
    Strings(usize),
    /// A string cut to its first this many characters on a `char` boundary. A value that is
    /// not a string is dropped from its object.
    Text(usize),
    /// An object's keys, each value replaced by an empty string. A value that is not an
    /// object is kept as it is.
    Blank,
}

use Keep::{All, Blank, Each, Fields, Strings, Text};

impl Keep {
    /// Whether an object keeps `value` under this rule at all.
    fn admits(&self, value: &Value) -> bool {
        !matches!(self, Text(_)) || value.is_string()
    }
}

/// The characters a Pod row keeps of each annotation value (spec M24).
const ANNOTATION_CHARS: usize = 256;

/// The characters a Pod row keeps of its status message (spec N20).
const MESSAGE_CHARS: usize = 256;

/// What the table's Ready, Status and Restarts columns read of a container's status.
const CONTAINER_STATUS: Keep = Fields(&[
    ("name", All),
    ("ready", All),
    ("started", All),
    ("restartCount", All),
    (
        "state",
        Fields(&[
            ("running", All),
            ("waiting", Fields(&[("reason", All)])),
            (
                "terminated",
                Fields(&[("reason", All), ("signal", All), ("exitCode", All)]),
            ),
        ]),
    ),
]);

/// What the Pods table's Ready, Status and Restarts columns and the graph's Pod status read.
const POD_STATUS: Keep = Fields(&[
    ("phase", All),
    ("reason", All),
    ("podIP", All),
    ("qosClass", All),
    (
        "conditions",
        Each(&Fields(&[("type", All), ("status", All), ("reason", All)])),
    ),
    ("containerStatuses", Each(&CONTAINER_STATUS)),
    ("initContainerStatuses", Each(&CONTAINER_STATUS)),
]);

/// A Pod row's status: what the graph reads, plus the message the workload Status card shows,
/// such as why the Pod was evicted (spec N20).
const POD_ROW_STATUS: Keep = Fields(&[
    ("phase", All),
    ("reason", All),
    ("message", Text(MESSAGE_CHARS)),
    ("podIP", All),
    ("qosClass", All),
    (
        "conditions",
        Each(&Fields(&[("type", All), ("status", All), ("reason", All)])),
    ),
    ("containerStatuses", Each(&CONTAINER_STATUS)),
    ("initContainerStatuses", Each(&CONTAINER_STATUS)),
]);

/// An object reference the graph follows: only its name.
const NAME_ONLY: Keep = Fields(&[("name", All)]);

/// The environment variables that name a ConfigMap or Secret. A value is never kept.
const ENV_REFS: Keep = Each(&Fields(&[(
    "valueFrom",
    Fields(&[("configMapKeyRef", NAME_ONLY), ("secretKeyRef", NAME_ONLY)]),
)]));

const ENV_FROM_REFS: Keep = Each(&Fields(&[
    ("configMapRef", NAME_ONLY),
    ("secretRef", NAME_ONLY),
]));

/// What the relationship graph (spec E §4) reads of a Pod: its owner and labels, the objects
/// it mounts, reads and runs as, and what its status and facts need.
const POD_GRAPH: Keep = Fields(&[
    ("apiVersion", All),
    ("kind", All),
    (
        "metadata",
        Fields(&[
            ("name", All),
            ("namespace", All),
            ("creationTimestamp", All),
            ("deletionTimestamp", All),
            ("labels", All),
            ("ownerReferences", All),
        ]),
    ),
    (
        "spec",
        Fields(&[
            ("nodeName", All),
            ("serviceAccountName", All),
            (
                "volumes",
                Each(&Fields(&[
                    ("configMap", NAME_ONLY),
                    ("secret", Fields(&[("secretName", All)])),
                    ("persistentVolumeClaim", Fields(&[("claimName", All)])),
                    (
                        "projected",
                        Fields(&[(
                            "sources",
                            Each(&Fields(&[("configMap", NAME_ONLY), ("secret", NAME_ONLY)])),
                        )]),
                    ),
                ])),
            ),
            (
                "containers",
                Each(&Fields(&[
                    ("name", All),
                    ("env", ENV_REFS),
                    ("envFrom", ENV_FROM_REFS),
                ])),
            ),
            (
                "initContainers",
                Each(&Fields(&[
                    ("name", All),
                    ("restartPolicy", All),
                    ("env", ENV_REFS),
                    ("envFrom", ENV_FROM_REFS),
                ])),
            ),
        ]),
    ),
    ("status", POD_STATUS),
]);

/// What every trimmed row keeps of its metadata: what an action or a fetch names the object
/// by, what the list sorts and shows, and what the graph and the owned-Pods lists follow. The
/// filter matches annotations, so they stay, cut.
const ROW_METADATA: Keep = Fields(&[
    ("name", All),
    ("namespace", All),
    ("uid", All),
    ("resourceVersion", All),
    ("creationTimestamp", All),
    ("deletionTimestamp", All),
    ("labels", All),
    ("annotations", Strings(ANNOTATION_CHARS)),
    ("ownerReferences", All),
]);

/// The Pods table, its filter and sort, the pod lists of the Node, Job and Rollout
/// drawers and the Pods row-menu Port forward action (which reads the container ports) read
/// these. `uid` and `resourceVersion` let an action or a fetch name the object. The filter
/// matches annotations, so they stay, cut.
const POD_ROW: Keep = Fields(&[
    ("apiVersion", All),
    ("kind", All),
    ("metadata", ROW_METADATA),
    (
        "spec",
        Fields(&[
            ("nodeName", All),
            (
                "containers",
                Each(&Fields(&[
                    ("name", All),
                    (
                        "ports",
                        Each(&Fields(&[
                            ("containerPort", All),
                            ("name", All),
                            ("protocol", All),
                        ])),
                    ),
                ])),
            ),
            (
                "initContainers",
                Each(&Fields(&[("name", All), ("restartPolicy", All)])),
            ),
        ]),
    ),
    ("status", POD_ROW_STATUS),
]);

/// The CRDs table, every custom resource's printer columns and `useRefreshOnCrdChange`
/// (Established) read these. The schemas, the conversion webhook and its `caBundle` stay out.
const CRD_ROW: Keep = Fields(&[
    ("apiVersion", All),
    ("kind", All),
    ("metadata", ROW_METADATA),
    (
        "spec",
        Fields(&[
            ("group", All),
            ("names", All),
            ("scope", All),
            (
                "versions",
                Each(&Fields(&[
                    ("name", All),
                    ("served", All),
                    ("storage", All),
                    ("deprecated", All),
                    ("additionalPrinterColumns", All),
                ])),
            ),
        ]),
    ),
    (
        "status",
        Fields(&[(
            "conditions",
            Each(&Fields(&[("type", All), ("status", All)])),
        )]),
    ),
]);

/// The ReplicaSets table, the log sources (selector, container names), the owned-Pods lists
/// (`uid`, owner references) and the graph (`spec.replicas`, the ready and available counts,
/// the revision annotation, the controller owner) read these.
const REPLICA_SET_ROW: Keep = Fields(&[
    ("apiVersion", All),
    ("kind", All),
    ("metadata", ROW_METADATA),
    (
        "spec",
        Fields(&[
            ("replicas", All),
            ("selector", All),
            (
                "template",
                Fields(&[(
                    "spec",
                    Fields(&[
                        ("containers", Each(&NAME_ONLY)),
                        ("initContainers", Each(&NAME_ONLY)),
                    ]),
                )]),
            ),
        ]),
    ),
    (
        "status",
        Fields(&[
            ("replicas", All),
            ("readyReplicas", All),
            ("availableReplicas", All),
        ]),
    ),
]);

/// The Nodes table, the cordon and node-shell actions and the Overview gauges
/// (`status.allocatable`) read these. The images, the capacity and the volumes stay out.
const NODE_ROW: Keep = Fields(&[
    ("apiVersion", All),
    ("kind", All),
    ("metadata", ROW_METADATA),
    ("spec", Fields(&[("unschedulable", All), ("taints", All)])),
    (
        "status",
        Fields(&[
            (
                "conditions",
                Each(&Fields(&[
                    ("type", All),
                    ("status", All),
                    ("reason", All),
                    ("message", All),
                    ("lastTransitionTime", All),
                ])),
            ),
            ("addresses", All),
            ("allocatable", All),
            (
                "nodeInfo",
                Fields(&[
                    ("kubeletVersion", All),
                    ("operatingSystem", All),
                    ("architecture", All),
                ]),
            ),
        ]),
    ),
]);

/// The ConfigMaps table's Keys column and the graph's Keys fact count the keys, so the keys
/// stay and each value becomes `""`. The UI counts string values, so they stay strings.
const CONFIG_MAP_ROW: Keep = Fields(&[
    ("apiVersion", All),
    ("kind", All),
    ("metadata", ROW_METADATA),
    ("data", Blank),
    ("binaryData", Blank),
]);

/// A container's CPU and memory, the two amounts the topology sums.
const CPU_AND_MEMORY: Keep = Fields(&[("cpu", All), ("memory", All)]);

/// What the topology reads of a container's resources: its CPU and memory requests.
const CONTAINER_REQUESTS: Keep = Fields(&[("requests", CPU_AND_MEMORY)]);

/// What `graph::pod::pod_summary` reads of a container's status. `running` only has to be an
/// object, so it keeps no field.
const TOPOLOGY_CONTAINER_STATUS: Keep = Fields(&[
    ("name", All),
    ("ready", All),
    ("started", All),
    ("restartCount", All),
    (
        "state",
        Fields(&[
            ("running", Fields(&[])),
            ("waiting", Fields(&[("reason", All)])),
            (
                "terminated",
                Fields(&[("reason", All), ("signal", All), ("exitCode", All)]),
            ),
        ]),
    ),
]);

/// What the node topology reads of a Pod (topology spec §4.1): where it runs, what it requests
/// and what its summary text reads.
const POD_TOPOLOGY: Keep = Fields(&[
    (
        "metadata",
        Fields(&[
            ("name", All),
            ("namespace", All),
            ("deletionTimestamp", All),
        ]),
    ),
    (
        "spec",
        Fields(&[
            ("nodeName", All),
            ("overhead", CPU_AND_MEMORY),
            (
                "containers",
                Each(&Fields(&[("name", All), ("resources", CONTAINER_REQUESTS)])),
            ),
            (
                "initContainers",
                Each(&Fields(&[
                    ("name", All),
                    ("restartPolicy", All),
                    ("resources", CONTAINER_REQUESTS),
                ])),
            ),
        ]),
    ),
    (
        "status",
        Fields(&[
            ("phase", All),
            ("reason", All),
            (
                "conditions",
                Each(&Fields(&[("type", All), ("status", All), ("reason", All)])),
            ),
            ("containerStatuses", Each(&TOPOLOGY_CONTAINER_STATUS)),
            ("initContainerStatuses", Each(&TOPOLOGY_CONTAINER_STATUS)),
        ]),
    ),
]);

/// What the node topology reads of a Node (topology spec §4.1).
const NODE_TOPOLOGY: Keep = Fields(&[
    ("metadata", Fields(&[("name", All), ("labels", All)])),
    ("spec", Fields(&[("unschedulable", All), ("taints", All)])),
    (
        "status",
        Fields(&[
            (
                "conditions",
                Each(&Fields(&[("type", All), ("status", All)])),
            ),
            (
                "allocatable",
                Fields(&[("cpu", All), ("memory", All), ("pods", All)]),
            ),
        ]),
    ),
]);

/// A value of another shape than the rule expects is kept as it is.
fn keep(value: &mut Value, rule: &Keep) {
    match rule {
        All => {}
        Fields(fields) => {
            if let Some(object) = value.as_object_mut() {
                object.retain(|key, child| {
                    fields
                        .iter()
                        .any(|(name, rule)| name == key && rule.admits(child))
                });
                for (name, rule) in *fields {
                    if let Some(child) = object.get_mut(*name) {
                        keep(child, rule);
                    }
                }
            }
        }
        Each(rule) => {
            if let Some(items) = value.as_array_mut() {
                for item in items {
                    keep(item, rule);
                }
            }
        }
        Strings(max) => {
            if let Some(object) = value.as_object_mut() {
                object.retain(|_, child| match child {
                    Value::String(text) => {
                        cut_chars(text, *max);
                        true
                    }
                    _ => false,
                });
            }
        }
        Text(max) => {
            if let Value::String(text) = value {
                cut_chars(text, *max);
            }
        }
        Blank => {
            if let Some(object) = value.as_object_mut() {
                for child in object.values_mut() {
                    *child = Value::String(String::new());
                }
            }
        }
    }
}

/// Cuts `text` to its first `max` characters, on a `char` boundary.
fn cut_chars(text: &mut String, max: usize) {
    if let Some((end, _)) = text.char_indices().nth(max) {
        text.truncate(end);
    }
}

/// Core `v1` Pods are the only rows with a graph shape of their own.
pub(super) fn is_core_pods(resource: &ResourceRef) -> bool {
    resource.group.is_empty() && resource.plural == "pods"
}

/// Core `v1` Nodes.
fn is_core_nodes(resource: &ResourceRef) -> bool {
    resource.group.is_empty() && resource.plural == "nodes"
}

/// Core Pods and Nodes are the only rows with a topology shape of their own.
pub(super) fn has_topology_row(resource: &ResourceRef) -> bool {
    is_core_pods(resource) || is_core_nodes(resource)
}

/// The rule a (group, plural) is trimmed by, for a table row or the Pod table's shape.
fn row_rule(resource: &ResourceRef) -> Option<&'static Keep> {
    match (resource.group.as_str(), resource.plural.as_str()) {
        ("", "pods") => Some(&POD_ROW),
        ("", "nodes") => Some(&NODE_ROW),
        ("", "configmaps") => Some(&CONFIG_MAP_ROW),
        ("apps", "replicasets") => Some(&REPLICA_SET_ROW),
        ("apiextensions.k8s.io", "customresourcedefinitions") => Some(&CRD_ROW),
        _ => None,
    }
}

/// Trims a row after `strip_for_list`. Only the kinds with a rule above are trimmed.
pub(super) fn trim_for_watch(resource: &ResourceRef, row: &mut Value) {
    if let Some(rule) = row_rule(resource) {
        keep(row, rule);
    }
}

/// Trims a graph row after `strip_for_list`. A core Pod keeps what the relationship graph
/// reads, and never an environment variable's value.
pub(super) fn trim_for_graph(resource: &ResourceRef, row: &mut Value) {
    if is_core_pods(resource) {
        keep(row, &POD_GRAPH);
    }
}

/// Trims a topology row after `strip_for_list`. A core Pod or Node keeps what the node
/// topology reads; any other row is left as it is.
pub(super) fn trim_for_topology(resource: &ResourceRef, row: &mut Value) {
    if is_core_pods(resource) {
        keep(row, &POD_TOPOLOGY);
    } else if is_core_nodes(resource) {
        keep(row, &NODE_TOPOLOGY);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn resource(group: &str, plural: &str, kind: &str) -> ResourceRef {
        ResourceRef {
            group: group.into(),
            version: "v1".into(),
            plural: plural.into(),
            kind: kind.into(),
            namespaced: true,
        }
    }

    fn container_status(name: &str) -> Value {
        json!({
            "name": name,
            "image": "registry.example.com/app:1",
            "imageID": "registry.example.com/app@sha256:abc",
            "containerID": "containerd://123",
            "ready": false,
            "started": true,
            "restartCount": 3,
            "state": {
                "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 5m0s restarting" },
            },
            "lastState": {
                "terminated": { "reason": "Error", "exitCode": 1, "message": "a long termination message" },
            },
        })
    }

    fn full_pod() -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "web-1",
                "namespace": "default",
                "uid": "u-1",
                "resourceVersion": "42",
                "creationTimestamp": "2026-11-01T08:00:00Z",
                "deletionTimestamp": "2026-11-01T09:00:00Z",
                "generateName": "web-",
                "labels": { "app": "web" },
                "annotations": { "prometheus.io/scrape": "true" },
                "ownerReferences": [{ "kind": "ReplicaSet", "name": "web", "uid": "u-rs", "apiVersion": "apps/v1" }],
                "finalizers": ["example.com/hold"],
            },
            "spec": {
                "nodeName": "node-1",
                "serviceAccountName": "web",
                "volumes": [{ "name": "data", "emptyDir": {} }],
                "initContainers": [{
                    "name": "setup",
                    "image": "registry.example.com/setup:1",
                    "restartPolicy": "Always",
                    "env": [{ "name": "A", "value": "1" }],
                }],
                "containers": [{
                    "name": "app",
                    "image": "registry.example.com/app:1",
                    "env": [{ "name": "B", "value": "2" }],
                    "ports": [{ "name": "http", "containerPort": 8080, "protocol": "TCP", "hostPort": 18080 }],
                    "livenessProbe": { "httpGet": { "path": "/healthz", "port": 8080 } },
                }],
            },
            "status": {
                "phase": "Running",
                "reason": "Evicted",
                "message": "The node was low on resource: memory.",
                "podIP": "10.0.0.1",
                "hostIP": "192.168.0.1",
                "qosClass": "Burstable",
                "startTime": "2026-11-01T08:00:00Z",
                "conditions": [{
                    "type": "Ready",
                    "status": "False",
                    "reason": "ContainersNotReady",
                    "message": "dropped",
                    "lastTransitionTime": "2026-11-01T08:00:06Z",
                }],
                "initContainerStatuses": [container_status("setup")],
                "containerStatuses": [{
                    "name": "app",
                    "ready": true,
                    "restartCount": 0,
                    "state": { "running": { "startedAt": "2026-11-01T08:00:05Z" } },
                }, {
                    "name": "sidecar",
                    "ready": false,
                    "restartCount": 1,
                    "state": { "terminated": { "reason": "OOMKilled", "signal": 9, "exitCode": 137, "message": "dropped" } },
                }],
            },
        })
    }

    #[test]
    fn a_pod_row_keeps_what_the_ui_reads_outside_the_drawer() {
        let mut row = full_pod();
        trim_for_watch(&resource("", "pods", "Pod"), &mut row);
        let kept_status = json!({
            "name": "setup",
            "ready": false,
            "started": true,
            "restartCount": 3,
            "state": { "waiting": { "reason": "CrashLoopBackOff" } },
        });
        assert_eq!(
            row,
            json!({
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": {
                    "name": "web-1",
                    "namespace": "default",
                    "uid": "u-1",
                    "resourceVersion": "42",
                    "creationTimestamp": "2026-11-01T08:00:00Z",
                    "deletionTimestamp": "2026-11-01T09:00:00Z",
                    "labels": { "app": "web" },
                    "annotations": { "prometheus.io/scrape": "true" },
                    "ownerReferences": [{ "kind": "ReplicaSet", "name": "web", "uid": "u-rs", "apiVersion": "apps/v1" }],
                },
                "spec": {
                    "nodeName": "node-1",
                    "initContainers": [{ "name": "setup", "restartPolicy": "Always" }],
                    "containers": [{ "name": "app", "ports": [{ "name": "http", "containerPort": 8080, "protocol": "TCP" }] }],
                },
                "status": {
                    "phase": "Running",
                    "reason": "Evicted",
                    "message": "The node was low on resource: memory.",
                    "podIP": "10.0.0.1",
                    "qosClass": "Burstable",
                    "conditions": [{ "type": "Ready", "status": "False", "reason": "ContainersNotReady" }],
                    "initContainerStatuses": [kept_status],
                    "containerStatuses": [{
                        "name": "app",
                        "ready": true,
                        "restartCount": 0,
                        "state": { "running": { "startedAt": "2026-11-01T08:00:05Z" } },
                    }, {
                        "name": "sidecar",
                        "ready": false,
                        "restartCount": 1,
                        "state": { "terminated": { "reason": "OOMKilled", "signal": 9, "exitCode": 137 } },
                    }],
                },
            })
        );
    }

    #[test]
    fn other_resources_named_pods_and_other_kinds_stay_whole() {
        // PodMetrics are served as `pods` too, and their containers carry the usage.
        for resource in [
            resource("metrics.k8s.io", "pods", "PodMetrics"),
            resource("example.com", "configmaps", "ConfigMap"),
            resource("", "secrets", "Secret"),
            resource("metrics.k8s.io", "nodes", "NodeMetrics"),
            resource("", "replicasets", "ReplicaSet"),
        ] {
            let mut row = full_pod();
            trim_for_watch(&resource, &mut row);
            assert_eq!(row, full_pod(), "{}", resource.plural);
        }
    }

    #[test]
    fn a_pod_missing_parts_or_shaped_oddly_is_kept_as_far_as_it_goes() {
        let mut row = json!({
            "kind": "Pod",
            "metadata": { "name": "odd", "annotations": "not a map" },
            "spec": null,
            "status": { "containerStatuses": "not a list", "conditions": [1, "two"] },
        });
        trim_for_watch(&resource("", "pods", "Pod"), &mut row);
        assert_eq!(
            row,
            json!({
                "kind": "Pod",
                "metadata": { "name": "odd", "annotations": "not a map" },
                "spec": null,
                "status": { "containerStatuses": "not a list", "conditions": [1, "two"] },
            })
        );
    }

    #[test]
    fn a_pod_row_cuts_each_annotation_value_to_256_characters_on_a_char_boundary() {
        let long = "a".repeat(10_000);
        let wide = "é".repeat(300);
        let mixed = format!("{}🙂🙂", "b".repeat(255));
        let mut row = full_pod();
        row["metadata"]["annotations"] = json!({
            "long": long,
            "wide": wide,
            "mixed": mixed,
            "short": "kept whole",
            "empty": "",
        });
        trim_for_watch(&resource("", "pods", "Pod"), &mut row);
        let annotations = &row["metadata"]["annotations"];
        assert_eq!(annotations["long"], "a".repeat(256));
        let wide = annotations["wide"].as_str().unwrap();
        assert_eq!(wide.chars().count(), 256);
        assert_eq!(wide, "é".repeat(256));
        assert_eq!(annotations["mixed"], format!("{}🙂", "b".repeat(255)));
        assert_eq!(annotations["short"], "kept whole");
        assert_eq!(annotations["empty"], "");
    }

    #[test]
    fn a_pod_row_drops_annotation_values_that_are_not_strings() {
        let mut row = full_pod();
        row["metadata"]["annotations"] = json!({
            "number": 5,
            "flag": true,
            "nested": { "a": "b" },
            "list": ["a"],
            "nothing": null,
            "text": "stays",
        });
        trim_for_watch(&resource("", "pods", "Pod"), &mut row);
        assert_eq!(row["metadata"]["annotations"], json!({ "text": "stays" }));
    }

    #[test]
    fn a_pod_row_cuts_its_status_message_to_256_characters_on_a_char_boundary() {
        let pods = resource("", "pods", "Pod");
        for (message, kept) in [
            ("a".repeat(10_000), "a".repeat(256)),
            ("é".repeat(300), "é".repeat(256)),
            (
                format!("{}🙂🙂", "b".repeat(255)),
                format!("{}🙂", "b".repeat(255)),
            ),
            ("kept whole".to_string(), "kept whole".to_string()),
        ] {
            let mut row = full_pod();
            row["status"]["message"] = json!(message);
            trim_for_watch(&pods, &mut row);
            assert_eq!(row["status"]["message"], json!(kept));
        }
    }

    #[test]
    fn a_pod_row_drops_a_status_message_that_is_not_a_string() {
        let pods = resource("", "pods", "Pod");
        for message in [
            json!(5),
            json!(true),
            json!({ "a": "b" }),
            json!(["a"]),
            Value::Null,
        ] {
            let mut row = full_pod();
            row["status"]["message"] = message;
            trim_for_watch(&pods, &mut row);
            assert!(row["status"].get("message").is_none(), "{row}");
            assert_eq!(row["status"]["phase"], "Running");
        }
    }

    #[test]
    fn other_kinds_keep_long_annotation_values_whole() {
        let long = "a".repeat(10_000);
        for resource in [
            resource("", "secrets", "Secret"),
            resource("apps", "deployments", "Deployment"),
            resource("metrics.k8s.io", "pods", "PodMetrics"),
        ] {
            let mut row = json!({
                "metadata": { "name": "x", "annotations": { "long": long, "number": 5 } },
            });
            let before = row.clone();
            trim_for_watch(&resource, &mut row);
            assert_eq!(row, before, "{}", resource.plural);
        }
    }

    #[test]
    fn a_graph_pod_row_keeps_the_references_and_no_values() {
        let mut row = full_pod();
        row["spec"]["volumes"] = json!([
            { "name": "cfg", "configMap": { "name": "web-config", "defaultMode": 420 } },
            { "name": "sec", "secret": { "secretName": "web-secret", "optional": true } },
            { "name": "data", "persistentVolumeClaim": { "claimName": "web-data" } },
            { "name": "token", "projected": { "sources": [
                { "serviceAccountToken": { "path": "token" } },
                { "configMap": { "name": "kube-root-ca.crt", "items": [{ "key": "ca.crt", "path": "ca.crt" }] } },
                { "secret": { "name": "extra" } },
            ] } },
        ]);
        row["spec"]["containers"][0]["env"] = json!([
            { "name": "PLAIN", "value": "visible-value" },
            { "name": "FROM_CM", "valueFrom": { "configMapKeyRef": { "name": "cm", "key": "k" } } },
            { "name": "FROM_SECRET", "valueFrom": { "secretKeyRef": { "name": "s", "key": "k" } } },
        ]);
        row["spec"]["containers"][0]["envFrom"] =
            json!([{ "secretRef": { "name": "all" }, "prefix": "P_" }]);

        trim_for_graph(&resource("", "pods", "Pod"), &mut row);

        assert_eq!(row["spec"]["serviceAccountName"], "web");
        assert_eq!(row["spec"]["nodeName"], "node-1");
        assert_eq!(
            row["spec"]["volumes"],
            json!([
                { "configMap": { "name": "web-config" } },
                { "secret": { "secretName": "web-secret" } },
                { "persistentVolumeClaim": { "claimName": "web-data" } },
                { "projected": { "sources": [
                    {},
                    { "configMap": { "name": "kube-root-ca.crt" } },
                    { "secret": { "name": "extra" } },
                ] } },
            ])
        );
        assert_eq!(
            row["spec"]["containers"][0],
            json!({
                "name": "app",
                "env": [
                    {},
                    { "valueFrom": { "configMapKeyRef": { "name": "cm" } } },
                    { "valueFrom": { "secretKeyRef": { "name": "s" } } },
                ],
                "envFrom": [{ "secretRef": { "name": "all" } }],
            })
        );
        assert_eq!(
            row["spec"]["initContainers"][0],
            json!({ "name": "setup", "restartPolicy": "Always", "env": [{}] })
        );
        assert_eq!(row["metadata"]["labels"], json!({ "app": "web" }));
        assert!(row["metadata"].get("uid").is_none());
        assert_eq!(row["status"]["initContainerStatuses"][0]["restartCount"], 3);
        assert_eq!(
            row["status"]["containerStatuses"][1]["state"]["terminated"]["reason"],
            "OOMKilled"
        );
        assert!(row["status"].get("message").is_none());
        let text = row.to_string();
        assert!(!text.contains("visible-value"), "{text}");
        assert!(!text.contains("registry.example.com"), "{text}");
    }

    #[test]
    fn a_graph_row_of_another_resource_is_untouched() {
        let mut row = json!({ "kind": "Deployment", "spec": { "template": { "spec": { "containers": [{ "image": "x" }] } } } });
        let before = row.clone();
        trim_for_graph(&resource("apps", "deployments", "Deployment"), &mut row);
        assert_eq!(row, before);
    }

    fn long_annotations() -> Value {
        json!({
            "short": "kept",
            "long": "é".repeat(300),
            "number": 5,
        })
    }

    fn row_metadata(name: &str, namespace: Option<&str>) -> Value {
        let mut metadata = json!({
            "name": name,
            "uid": format!("{name}-uid"),
            "resourceVersion": "42",
            "generation": 7,
            "creationTimestamp": "2026-11-01T08:00:00Z",
            "deletionTimestamp": "2026-11-01T09:00:00Z",
            "generateName": format!("{name}-"),
            "labels": { "app": "web" },
            "annotations": long_annotations(),
            "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "Deployment", "name": "web", "uid": "u-d", "controller": true }],
            "finalizers": ["example.com/hold"],
        });
        if let Some(namespace) = namespace {
            metadata["namespace"] = namespace.into();
        }
        metadata
    }

    /// What `row_metadata` becomes in a trimmed row.
    fn kept_metadata(name: &str, namespace: Option<&str>) -> Value {
        let mut metadata = json!({
            "name": name,
            "uid": format!("{name}-uid"),
            "resourceVersion": "42",
            "creationTimestamp": "2026-11-01T08:00:00Z",
            "deletionTimestamp": "2026-11-01T09:00:00Z",
            "labels": { "app": "web" },
            "annotations": { "short": "kept", "long": "é".repeat(256) },
            "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "Deployment", "name": "web", "uid": "u-d", "controller": true }],
        });
        if let Some(namespace) = namespace {
            metadata["namespace"] = namespace.into();
        }
        metadata
    }

    fn full_crd() -> Value {
        json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": row_metadata("widgets.example.com", None),
            "spec": {
                "group": "example.com",
                "scope": "Namespaced",
                "names": { "plural": "widgets", "singular": "widget", "kind": "Widget", "shortNames": ["wg"] },
                "preserveUnknownFields": false,
                "conversion": {
                    "strategy": "Webhook",
                    "webhook": { "clientConfig": { "caBundle": "Q0EtQlVORExF" }, "conversionReviewVersions": ["v1"] },
                },
                "versions": [{
                    "name": "v1",
                    "served": true,
                    "storage": true,
                    "deprecated": false,
                    "deprecationWarning": "use v2",
                    "schema": { "openAPIV3Schema": { "type": "object", "properties": { "spec": { "type": "object" } } } },
                    "subresources": { "status": {} },
                    "selectableFields": [{ "jsonPath": ".spec.size" }],
                    "additionalPrinterColumns": [{ "name": "Size", "type": "integer", "jsonPath": ".spec.size", "description": "the size" }],
                }],
            },
            "status": {
                "acceptedNames": { "plural": "widgets", "kind": "Widget" },
                "storedVersions": ["v1"],
                "conditions": [{
                    "type": "Established",
                    "status": "True",
                    "reason": "InitialNamesAccepted",
                    "message": "the initial names have been accepted",
                    "lastTransitionTime": "2026-11-01T08:00:01Z",
                }],
            },
        })
    }

    fn trimmed_crd() -> Value {
        json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": kept_metadata("widgets.example.com", None),
            "spec": {
                "group": "example.com",
                "scope": "Namespaced",
                "names": { "plural": "widgets", "singular": "widget", "kind": "Widget", "shortNames": ["wg"] },
                "versions": [{
                    "name": "v1",
                    "served": true,
                    "storage": true,
                    "deprecated": false,
                    "additionalPrinterColumns": [{ "name": "Size", "type": "integer", "jsonPath": ".spec.size", "description": "the size" }],
                }],
            },
            "status": { "conditions": [{ "type": "Established", "status": "True" }] },
        })
    }

    fn full_replica_set() -> Value {
        json!({
            "apiVersion": "apps/v1",
            "kind": "ReplicaSet",
            "metadata": row_metadata("web-1", Some("default")),
            "spec": {
                "replicas": 3,
                "minReadySeconds": 5,
                "selector": { "matchLabels": { "app": "web" } },
                "template": {
                    "metadata": { "labels": { "app": "web" } },
                    "spec": {
                        "serviceAccountName": "web",
                        "initContainers": [{ "name": "setup", "image": "registry.example.com/setup:1" }],
                        "containers": [{
                            "name": "app",
                            "image": "registry.example.com/app:1",
                            "env": [{ "name": "A", "value": "hidden-value" }],
                        }],
                    },
                },
            },
            "status": {
                "replicas": 3,
                "readyReplicas": 2,
                "availableReplicas": 2,
                "fullyLabeledReplicas": 3,
                "observedGeneration": 7,
                "conditions": [{ "type": "ReplicaFailure", "status": "False" }],
            },
        })
    }

    fn trimmed_replica_set() -> Value {
        json!({
            "apiVersion": "apps/v1",
            "kind": "ReplicaSet",
            "metadata": kept_metadata("web-1", Some("default")),
            "spec": {
                "replicas": 3,
                "selector": { "matchLabels": { "app": "web" } },
                "template": { "spec": {
                    "initContainers": [{ "name": "setup" }],
                    "containers": [{ "name": "app" }],
                } },
            },
            "status": { "replicas": 3, "readyReplicas": 2, "availableReplicas": 2 },
        })
    }

    fn full_node() -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": row_metadata("worker-1", None),
            "spec": {
                "podCIDR": "10.244.1.0/24",
                "providerID": "kind://docker/worker-1",
                "unschedulable": true,
                "taints": [{ "key": "dedicated", "value": "db", "effect": "NoSchedule", "timeAdded": "2026-11-01T08:00:00Z" }],
            },
            "status": {
                "capacity": { "cpu": "8", "memory": "16Gi" },
                "allocatable": { "cpu": "7800m", "memory": "15Gi", "pods": "110" },
                "addresses": [{ "type": "InternalIP", "address": "172.18.0.3" }, { "type": "Hostname", "address": "worker-1" }],
                "conditions": [{
                    "type": "Ready",
                    "status": "True",
                    "reason": "KubeletReady",
                    "message": "kubelet is posting ready status",
                    "lastHeartbeatTime": "2026-11-01T08:10:00Z",
                    "lastTransitionTime": "2026-11-01T08:00:06Z",
                }],
                "daemonEndpoints": { "kubeletEndpoint": { "Port": 10250 } },
                "images": [{ "names": ["registry.example.com/app:1"], "sizeBytes": 1234567 }],
                "volumesInUse": ["kubernetes.io/csi/x^1"],
                "volumesAttached": [{ "name": "kubernetes.io/csi/x^1", "devicePath": "" }],
                "nodeInfo": {
                    "kubeletVersion": "v1.31.2",
                    "operatingSystem": "linux",
                    "architecture": "arm64",
                    "machineID": "abc",
                    "systemUUID": "def",
                    "bootID": "ghi",
                    "kernelVersion": "6.8.0",
                    "osImage": "Debian GNU/Linux 12",
                    "containerRuntimeVersion": "containerd://1.7.1",
                    "kubeProxyVersion": "v1.31.2",
                },
            },
        })
    }

    fn trimmed_node() -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": kept_metadata("worker-1", None),
            "spec": {
                "unschedulable": true,
                "taints": [{ "key": "dedicated", "value": "db", "effect": "NoSchedule", "timeAdded": "2026-11-01T08:00:00Z" }],
            },
            "status": {
                "allocatable": { "cpu": "7800m", "memory": "15Gi", "pods": "110" },
                "addresses": [{ "type": "InternalIP", "address": "172.18.0.3" }, { "type": "Hostname", "address": "worker-1" }],
                "conditions": [{
                    "type": "Ready",
                    "status": "True",
                    "reason": "KubeletReady",
                    "message": "kubelet is posting ready status",
                    "lastTransitionTime": "2026-11-01T08:00:06Z",
                }],
                "nodeInfo": { "kubeletVersion": "v1.31.2", "operatingSystem": "linux", "architecture": "arm64" },
            },
        })
    }

    fn full_config_map() -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": row_metadata("web-config", Some("default")),
            "immutable": true,
            "data": { "mode": "fast", "empty": "", "big": "x".repeat(10_000) },
            "binaryData": { "blob": "AAEC" },
        })
    }

    fn trimmed_config_map() -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": kept_metadata("web-config", Some("default")),
            "data": { "mode": "", "empty": "", "big": "" },
            "binaryData": { "blob": "" },
        })
    }

    /// Each trimmed kind: its resource, a whole object and what its row keeps.
    fn trimmed_kinds() -> Vec<(ResourceRef, Value, Value)> {
        vec![
            (
                resource(
                    "apiextensions.k8s.io",
                    "customresourcedefinitions",
                    "CustomResourceDefinition",
                ),
                full_crd(),
                trimmed_crd(),
            ),
            (
                resource("apps", "replicasets", "ReplicaSet"),
                full_replica_set(),
                trimmed_replica_set(),
            ),
            (resource("", "nodes", "Node"), full_node(), trimmed_node()),
            (
                resource("", "configmaps", "ConfigMap"),
                full_config_map(),
                trimmed_config_map(),
            ),
        ]
    }

    #[test]
    fn a_crd_row_keeps_the_printer_columns_and_the_versions_flags() {
        let mut row = full_crd();
        trim_for_watch(
            &resource(
                "apiextensions.k8s.io",
                "customresourcedefinitions",
                "CustomResourceDefinition",
            ),
            &mut row,
        );
        assert_eq!(row, trimmed_crd());
        assert!(
            !row.to_string().contains("Q0EtQlVORExF"),
            "the caBundle is gone"
        );
    }

    #[test]
    fn a_replica_set_row_keeps_the_selector_container_names_and_replica_counts() {
        let mut row = full_replica_set();
        trim_for_watch(&resource("apps", "replicasets", "ReplicaSet"), &mut row);
        assert_eq!(row, trimmed_replica_set());
        assert!(!row.to_string().contains("hidden-value"));
    }

    #[test]
    fn a_node_row_keeps_what_the_table_the_actions_and_the_gauges_read() {
        let mut row = full_node();
        trim_for_watch(&resource("", "nodes", "Node"), &mut row);
        assert_eq!(row, trimmed_node());
    }

    #[test]
    fn a_config_map_row_keeps_its_keys_with_empty_string_values() {
        let mut row = full_config_map();
        trim_for_watch(&resource("", "configmaps", "ConfigMap"), &mut row);
        assert_eq!(row, trimmed_config_map());
        assert!(!row.to_string().contains("xxxx"));
    }

    #[test]
    fn every_trimmed_kind_cuts_annotation_values_and_drops_non_strings() {
        for (resource, mut row, _) in trimmed_kinds() {
            trim_for_watch(&resource, &mut row);
            assert_eq!(
                row["metadata"]["annotations"],
                json!({ "short": "kept", "long": "é".repeat(256) }),
                "{}",
                resource.plural
            );
        }
    }

    #[test]
    fn strip_for_list_leaves_the_trimmed_kinds_whole() {
        // `resource_get` and `resource_events` use `strip_for_list`, and need whole objects.
        for (resource, full, _) in trimmed_kinds() {
            let mut stripped = full.clone();
            super::super::sanitize::strip_for_list(&mut stripped);
            assert_eq!(stripped, full, "{}", resource.plural);
        }
    }

    #[test]
    fn a_trimmed_kind_shaped_oddly_is_kept_as_far_as_it_goes() {
        for (resource, _, _) in trimmed_kinds() {
            for odd in [
                json!({}),
                json!({ "metadata": "x", "spec": null, "status": [], "data": "text", "binaryData": null }),
                json!({ "spec": { "versions": "no", "taints": 3, "template": [] }, "status": { "conditions": [1, "two"], "nodeInfo": 4 } }),
            ] {
                let mut row = odd.clone();
                trim_for_watch(&resource, &mut row);
                assert!(row.is_object(), "{}", resource.plural);
            }
        }
    }

    #[test]
    fn a_topology_pod_row_keeps_what_the_topology_reads() {
        let mut row = full_pod();
        row["spec"]["overhead"] = json!({ "cpu": "10m", "memory": "8Mi", "example.com/gpu": "1" });
        row["spec"]["containers"][0]["resources"] = json!({
            "requests": { "cpu": "250m", "memory": "64Mi", "ephemeral-storage": "1Gi" },
            "limits": { "cpu": "1" },
        });
        row["spec"]["initContainers"][0]["resources"] = json!({ "requests": { "cpu": "100m" } });

        trim_for_topology(&resource("", "pods", "Pod"), &mut row);

        assert_eq!(
            row,
            json!({
                "metadata": {
                    "name": "web-1",
                    "namespace": "default",
                    "deletionTimestamp": "2026-11-01T09:00:00Z",
                },
                "spec": {
                    "nodeName": "node-1",
                    "overhead": { "cpu": "10m", "memory": "8Mi" },
                    "initContainers": [{
                        "name": "setup",
                        "restartPolicy": "Always",
                        "resources": { "requests": { "cpu": "100m" } },
                    }],
                    "containers": [{
                        "name": "app",
                        "resources": { "requests": { "cpu": "250m", "memory": "64Mi" } },
                    }],
                },
                "status": {
                    "phase": "Running",
                    "reason": "Evicted",
                    "conditions": [{ "type": "Ready", "status": "False", "reason": "ContainersNotReady" }],
                    "initContainerStatuses": [{
                        "name": "setup",
                        "ready": false,
                        "started": true,
                        "restartCount": 3,
                        "state": { "waiting": { "reason": "CrashLoopBackOff" } },
                    }],
                    "containerStatuses": [{
                        "name": "app",
                        "ready": true,
                        "restartCount": 0,
                        "state": { "running": {} },
                    }, {
                        "name": "sidecar",
                        "ready": false,
                        "restartCount": 1,
                        "state": { "terminated": { "reason": "OOMKilled", "signal": 9, "exitCode": 137 } },
                    }],
                },
            })
        );
    }

    #[test]
    fn a_topology_node_row_keeps_what_the_topology_reads() {
        let mut row = full_node();
        row["status"]["allocatable"]["hugepages-2Mi"] = json!("0");

        trim_for_topology(&resource("", "nodes", "Node"), &mut row);

        assert_eq!(
            row,
            json!({
                "metadata": { "name": "worker-1", "labels": { "app": "web" } },
                "spec": {
                    "unschedulable": true,
                    "taints": [{ "key": "dedicated", "value": "db", "effect": "NoSchedule", "timeAdded": "2026-11-01T08:00:00Z" }],
                },
                "status": {
                    "conditions": [{ "type": "Ready", "status": "True" }],
                    "allocatable": { "cpu": "7800m", "memory": "15Gi", "pods": "110" },
                },
            })
        );
    }

    #[test]
    fn only_core_pods_and_nodes_have_a_topology_trim() {
        for (group, plural, trimmed) in [
            ("", "pods", true),
            ("", "nodes", true),
            ("", "secrets", false),
            ("example.com", "nodes", false),
            ("example.com", "pods", false),
        ] {
            assert_eq!(
                has_topology_row(&resource(group, plural, "X")),
                trimmed,
                "{group}/{plural}"
            );
        }
        let mut row = json!({ "kind": "Secret", "data": { "a": "b" } });
        let before = row.clone();
        trim_for_topology(&resource("", "secrets", "Secret"), &mut row);
        assert_eq!(row, before);
    }
}
