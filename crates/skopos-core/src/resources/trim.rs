//! What a watched row keeps of its object. A table holds every row of a resource, and the
//! webview's memory grows with what each row carries. So a core Pod row keeps only what the
//! UI reads outside the detail drawer, which fetches the whole object with `resource_get`.
//! Its annotations stay for the list's filter, each value cut short (spec M24), and so does its
//! status message for the workload Status card, cut the same way (spec N20).

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
}

use Keep::{All, Each, Fields, Strings, Text};

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

/// The Pods table, its filter and sort, the pod lists of the Node, Job and Rollout
/// drawers, the Pods row-menu Port forward action (which reads the container ports) and the
/// Workspace Pods view's Image column (spec E §4.9) read these. `uid` and `resourceVersion` let
/// an action or a fetch name the object. The filter matches annotations, so they stay, cut.
const POD_ROW: Keep = Fields(&[
    ("apiVersion", All),
    ("kind", All),
    (
        "metadata",
        Fields(&[
            ("name", All),
            ("namespace", All),
            ("uid", All),
            ("resourceVersion", All),
            ("creationTimestamp", All),
            ("deletionTimestamp", All),
            ("labels", All),
            ("annotations", Strings(ANNOTATION_CHARS)),
            ("ownerReferences", All),
        ]),
    ),
    (
        "spec",
        Fields(&[
            ("nodeName", All),
            (
                "containers",
                Each(&Fields(&[
                    ("name", All),
                    ("image", All),
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
    }
}

/// Cuts `text` to its first `max` characters, on a `char` boundary.
fn cut_chars(text: &mut String, max: usize) {
    if let Some((end, _)) = text.char_indices().nth(max) {
        text.truncate(end);
    }
}

/// Core `v1` Pods are the only rows trimmed, and the only ones with a graph shape of their own.
pub(super) fn is_core_pods(resource: &ResourceRef) -> bool {
    resource.group.is_empty() && resource.plural == "pods"
}

/// Trims a row after `strip_for_list`. Only core `v1` Pods are trimmed.
pub(super) fn trim_for_watch(resource: &ResourceRef, row: &mut Value) {
    if is_core_pods(resource) {
        keep(row, &POD_ROW);
    }
}

/// Trims a graph row after `strip_for_list`. A core Pod keeps what the relationship graph
/// reads, and never an environment variable's value.
pub(super) fn trim_for_graph(resource: &ResourceRef, row: &mut Value) {
    if is_core_pods(resource) {
        keep(row, &POD_GRAPH);
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
                    "containers": [{ "name": "app", "image": "registry.example.com/app:1", "ports": [{ "name": "http", "containerPort": 8080, "protocol": "TCP" }] }],
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
            resource("", "configmaps", "ConfigMap"),
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
            resource("", "configmaps", "ConfigMap"),
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
}
