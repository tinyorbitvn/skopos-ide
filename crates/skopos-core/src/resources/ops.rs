//! Reading, replacing and deleting one object, and the events about it. Requests
//! are sent and answered as plain JSON, so an object reaches the API server and the
//! caller as written, and a malformed one gets the API server's own message.

use std::cmp::Reverse;

use k8s_openapi::api::core::v1::Event;
use k8s_openapi::jiff::Timestamp;
use kube::api::{ApiResource, DeleteParams, DynamicObject, GetParams, ListParams, PostParams};
use kube::core::request::Error as RequestError;
use kube::core::{Request, Resource};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::apply::parse_documents;
use super::hub::{api_version, stamped_kind, validate};
use super::sanitize::strip_for_list;
use super::types::ResourceRef;
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

const MAX_EVENTS: usize = 100;

/// What happens to the objects an object owns when it is deleted.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Propagation {
    #[default]
    Background,
    Foreground,
    Orphan,
}

/// The object whose events are wanted.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InvolvedRef {
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: Option<String>,
}

pub(crate) fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

/// Whether the API server accepts this as a name in a request path. Anything else
/// would address a different path than the one meant.
pub(crate) fn is_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '%', '?', '#', '\\'])
}

pub(super) async fn send(
    client: &Client,
    request: Result<http::Request<Vec<u8>>, RequestError>,
) -> CoreResult<Value> {
    let request = request.map_err(kube::Error::BuildRequest)?;
    Ok(client.request(request).await?)
}

/// The requests for one object. A namespaced resource needs a namespace, and a
/// cluster-scoped one ignores it.
pub(super) fn object_request(
    r: &ResourceRef,
    namespace: Option<&str>,
    name: &str,
) -> CoreResult<Request> {
    if !is_path_segment(name) {
        return Err(invalid("the object name is not valid"));
    }
    let namespace = if r.namespaced {
        match namespace {
            Some(namespace) if is_path_segment(namespace) => Some(namespace),
            Some(_) => return Err(invalid("the namespace is not valid")),
            None => return Err(invalid(format!("{} needs a namespace", r.kind))),
        }
    } else {
        None
    };
    resource_request(r, namespace)
}

/// The parts of `r` become the URL path, and what gets blanked in the answer depends on
/// them, so a reference holding a path is refused here, before any request.
pub(super) fn resource_request(r: &ResourceRef, namespace: Option<&str>) -> CoreResult<Request> {
    validate(r)?;
    let resource = ApiResource {
        group: r.group.clone(),
        version: r.version.clone(),
        api_version: api_version(r),
        kind: r.kind.clone(),
        plural: r.plural.clone(),
    };
    Ok(Request::new(DynamicObject::url_path(&resource, namespace)))
}

/// Sets `kind` and `apiVersion` from the resource, so that what is decided from them,
/// such as whether values are blanked, does not rest on the server's answer or the
/// caller's `kind`. List items from an API server carry neither.
fn stamped(mut object: Value, r: &ResourceRef) -> Value {
    if let Some(fields) = object.as_object_mut() {
        fields.insert("apiVersion".to_owned(), api_version(r).into());
        fields.insert("kind".to_owned(), stamped_kind(r).into());
    }
    object
}

/// Stamps the object, then strips it, which depends on `kind` and `apiVersion`.
fn masked(object: Value, r: &ResourceRef) -> Value {
    let mut object = stamped(object, r);
    strip_for_list(&mut object);
    object
}

/// The items of a list the API server answered.
fn items_of(mut list: Value) -> Vec<Value> {
    match list.get_mut("items").map(Value::take) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// Checks that the YAML still describes the object being edited.
fn check_target(
    document: &Value,
    r: &ResourceRef,
    namespace: Option<&str>,
    name: &str,
) -> CoreResult<()> {
    let text = |pointer: &str| document.pointer(pointer).and_then(Value::as_str);
    if text("/apiVersion") != Some(api_version(r).as_str()) {
        return Err(invalid("apiVersion does not match the object being edited"));
    }
    if text("/kind") != Some(r.kind.as_str()) {
        return Err(invalid("kind does not match the object being edited"));
    }
    if text("/metadata/name") != Some(name) {
        return Err(invalid(
            "metadata.name does not match the object being edited",
        ));
    }
    if r.namespaced && text("/metadata/namespace").is_some_and(|ns| Some(ns) != namespace) {
        return Err(invalid(
            "metadata.namespace does not match the object being edited",
        ));
    }
    Ok(())
}

fn set_resource_version(document: &mut Value, version: &str) {
    if let Some(metadata) = document.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.insert("resourceVersion".to_owned(), version.into());
    }
}

/// A field selector value, with what the selector syntax gives a meaning escaped.
pub(super) fn selector_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(',', "\\,")
        .replace('=', "\\=")
}

fn event_selector(involved: &InvolvedRef) -> String {
    let mut terms = vec![
        format!("involvedObject.kind={}", selector_value(&involved.kind)),
        format!("involvedObject.name={}", selector_value(&involved.name)),
    ];
    if let Some(namespace) = &involved.namespace {
        terms.push(format!(
            "involvedObject.namespace={}",
            selector_value(namespace)
        ));
    }
    if let Some(uid) = &involved.uid {
        terms.push(format!("involvedObject.uid={}", selector_value(uid)));
    }
    terms.join(",")
}

/// When an event was last seen. Events carry this in different fields, depending
/// on the API they were written through, and in different precisions.
fn last_seen(event: &Value) -> Option<Timestamp> {
    [
        "/lastTimestamp",
        "/series/lastObservedTime",
        "/eventTime",
        "/firstTimestamp",
        "/metadata/creationTimestamp",
    ]
    .into_iter()
    .filter_map(|field| event.pointer(field)?.as_str()?.parse().ok())
    .max()
}

impl AppCore {
    pub(super) async fn fetch_object(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
    ) -> CoreResult<Value> {
        let request = object_request(r, namespace, name)?;
        let client = self.cluster_client(id)?;
        send(&client, request.get(name, &GetParams::default())).await
    }

    /// Objects of one resource, read once, for a panel that needs a few of them and not a
    /// watch of the whole cluster. Without a namespace it reads all of them, and a
    /// cluster-scoped resource ignores the namespace. Each is prepared as `resource_get`
    /// prepares one, so Secret values are blanked.
    pub async fn resources_list(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        label_selector: Option<&str>,
        field_selector: Option<&str>,
    ) -> CoreResult<Vec<Value>> {
        let mut items = self
            .resources_list_raw(id, r, namespace, label_selector, field_selector)
            .await?;
        for item in &mut items {
            strip_for_list(item);
        }
        Ok(items)
    }

    /// As `resources_list`, with `kind` and `apiVersion` set from `r` and nothing removed,
    /// for the agent tools, which trim what they return themselves (R4).
    pub(crate) async fn resources_list_raw(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        label_selector: Option<&str>,
        field_selector: Option<&str>,
    ) -> CoreResult<Vec<Value>> {
        let namespace = namespace.filter(|_| r.namespaced);
        if namespace.is_some_and(|namespace| !is_path_segment(namespace)) {
            return Err(invalid("the namespace is not valid"));
        }
        let request = resource_request(r, namespace)?;
        let client = self.cluster_client(id)?;
        let mut params = ListParams::default();
        if let Some(labels) = label_selector {
            params = params.labels(labels);
        }
        if let Some(fields) = field_selector {
            params = params.fields(fields);
        }
        let list = send(&client, request.list(&params)).await?;
        Ok(items_of(list)
            .into_iter()
            .map(|item| stamped(item, r))
            .collect())
    }

    /// One object, for showing: `managedFields` removed and Secret values blanked.
    pub async fn resource_get(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
    ) -> CoreResult<Value> {
        let mut object = self.resource_get_raw(id, r, namespace, name).await?;
        strip_for_list(&mut object);
        Ok(object)
    }

    /// As `resource_get`, with `kind` and `apiVersion` set from `r` and nothing removed.
    pub(crate) async fn resource_get_raw(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
    ) -> CoreResult<Value> {
        let object = self.fetch_object(id, r, namespace, name).await?;
        Ok(stamped(object, r))
    }

    /// One object as YAML, for editing: `managedFields` removed. Secret values stay,
    /// because the user asked to edit the object.
    pub async fn resource_get_yaml(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
    ) -> CoreResult<String> {
        let mut object = self.fetch_object(id, r, namespace, name).await?;
        if let Some(metadata) = object.get_mut("metadata").and_then(Value::as_object_mut) {
            metadata.remove("managedFields");
        }
        serde_yaml_ng::to_string(&object).map_err(|_| {
            IpcError::new(
                ErrorCode::Internal,
                "the object could not be written as YAML",
            )
        })
    }

    /// Saves edited YAML with a PUT. The `resourceVersion` in the YAML makes the
    /// server refuse with a conflict when the object has changed since it was read.
    /// `force` overwrites such a change by using the current `resourceVersion`.
    /// Answers with the stored object, its Secret values blanked.
    pub async fn resource_replace(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
        yaml: &str,
        force: bool,
    ) -> CoreResult<Value> {
        self.replace(id, r, namespace, name, yaml, force, false)
            .await
    }

    /// A server dry run of saving `yaml` over the object, against its current
    /// `resourceVersion`, so a version that went stale does not fail it (spec A10). Answers
    /// with the object the server would store, Secret values blanked.
    pub async fn resource_replace_dry_run(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
        yaml: &str,
    ) -> CoreResult<Value> {
        self.replace(id, r, namespace, name, yaml, true, true).await
    }

    // private: the two public fns name each flag
    #[allow(clippy::too_many_arguments)]
    async fn replace(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
        yaml: &str,
        force: bool,
        dry_run: bool,
    ) -> CoreResult<Value> {
        let mut documents = parse_documents(yaml)?.into_iter();
        let (Some(mut document), None) = (documents.next(), documents.next()) else {
            return Err(invalid("expected exactly one YAML document"));
        };
        check_target(&document, r, namespace, name)?;
        let request = object_request(r, namespace, name)?;
        let client = self.cluster_client(id)?;
        if force {
            let current = send(&client, request.get(name, &GetParams::default())).await?;
            let version = current
                .pointer("/metadata/resourceVersion")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    IpcError::new(
                        ErrorCode::Internal,
                        "the current object has no resourceVersion",
                    )
                })?;
            set_resource_version(&mut document, version);
        } else if document
            .pointer("/metadata/resourceVersion")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            // The server would take this as permission to overwrite any change.
            return Err(invalid(
                "metadata.resourceVersion is missing, so a change on the server could not be noticed",
            ));
        }
        let body = serde_json::to_vec(&document)
            .map_err(|_| IpcError::new(ErrorCode::Internal, "the object could not be encoded"))?;
        let params = PostParams {
            dry_run,
            ..PostParams::default()
        };
        let stored = send(&client, request.replace(name, &params, body)).await?;
        Ok(masked(stored, r))
    }

    /// Deletes one object. A failure, including a missing object, is an error.
    pub async fn resource_delete(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
        propagation: Propagation,
    ) -> CoreResult<()> {
        let request = object_request(r, namespace, name)?;
        let client = self.cluster_client(id)?;
        let params = match propagation {
            Propagation::Background => DeleteParams::background(),
            Propagation::Foreground => DeleteParams::foreground(),
            Propagation::Orphan => DeleteParams::orphan(),
        };
        send(&client, request.delete(name, &params)).await?;
        Ok(())
    }

    /// The events about one object, newest first, at most `MAX_EVENTS`. Without a
    /// namespace they are looked for in all namespaces: the events about a
    /// cluster-scoped object live in one, which it does not name.
    pub async fn resource_events(
        &self,
        id: &ClusterId,
        involved: &InvolvedRef,
    ) -> CoreResult<Vec<Value>> {
        let namespace = involved.namespace.as_deref();
        if namespace.is_some_and(|namespace| !is_path_segment(namespace)) {
            return Err(invalid("the namespace is not valid"));
        }
        let client = self.cluster_client(id)?;
        let params = ListParams::default().fields(&event_selector(involved));
        let request = Request::new(Event::url_path(&(), namespace));
        let mut list = send(&client, request.list(&params)).await?;
        let mut events = match list.get_mut("items").map(Value::take) {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        };
        events.sort_by_cached_key(|event| Reverse(last_seen(event)));
        events.truncate(MAX_EVENTS);
        for event in &mut events {
            strip_for_list(event);
        }
        Ok(events)
    }

    /// Events newest first, at most `MAX_EVENTS`, read in each of `namespaces`, or in all
    /// namespaces when `None`. `kind` keeps the events about objects of that kind, and
    /// `name` those about objects of that name.
    pub(crate) async fn events_in(
        &self,
        id: &ClusterId,
        namespaces: Option<&[String]>,
        kind: Option<&str>,
        name: Option<&str>,
    ) -> CoreResult<Vec<Value>> {
        let mut terms = Vec::new();
        if let Some(kind) = kind {
            terms.push(format!("involvedObject.kind={}", selector_value(kind)));
        }
        if let Some(name) = name {
            terms.push(format!("involvedObject.name={}", selector_value(name)));
        }
        let mut params = ListParams::default();
        if !terms.is_empty() {
            params = params.fields(&terms.join(","));
        }
        let client = self.cluster_client(id)?;
        let mut events = Vec::new();
        match namespaces {
            None => {
                let request = Request::new(Event::url_path(&(), None));
                events.extend(items_of(send(&client, request.list(&params)).await?));
            }
            Some(namespaces) => {
                for namespace in namespaces {
                    if !is_path_segment(namespace) {
                        return Err(invalid("the namespace is not valid"));
                    }
                    let request = Request::new(Event::url_path(&(), Some(namespace.as_str())));
                    events.extend(items_of(send(&client, request.list(&params)).await?));
                }
            }
        }
        events.sort_by_cached_key(|event| Reverse(last_seen(event)));
        events.truncate(MAX_EVENTS);
        for event in &mut events {
            strip_for_list(event);
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stamping_sets_kind_and_api_version_and_keeps_secret_values() {
        let secrets = ResourceRef {
            group: String::new(),
            version: "v1".into(),
            plural: "secrets".into(),
            kind: "secret".into(),
            namespaced: true,
        };
        let item = json!({
            "metadata": { "name": "db", "managedFields": [{ "manager": "kubectl" }] },
            "data": { "password": "c2VjcmV0" },
        });
        let raw = stamped(item.clone(), &secrets);
        assert_eq!(raw["kind"], "Secret");
        assert_eq!(raw["apiVersion"], "v1");
        assert_eq!(raw["data"]["password"], "c2VjcmV0");
        assert_eq!(
            raw["metadata"]["managedFields"],
            json!([{ "manager": "kubectl" }])
        );
        let shown = masked(item, &secrets);
        assert_eq!(shown["data"]["password"], "");
        assert!(shown["metadata"].get("managedFields").is_none());
    }

    #[test]
    fn path_segments_exclude_what_would_change_the_path() {
        for good in ["app", "a.b-c", "kube-system", "system:node:a"] {
            assert!(is_path_segment(good), "{good}");
        }
        for bad in ["", ".", "..", "a/b", "a%2Fb", "a?b=c", "a#b", "a\\b"] {
            assert!(!is_path_segment(bad), "{bad}");
        }
    }

    #[test]
    fn selector_values_escape_the_selector_syntax() {
        assert_eq!(selector_value(r"a,b=c\d"), r"a\,b\=c\\d");
    }

    #[test]
    fn event_selector_names_only_what_is_known() {
        let mut involved = InvolvedRef {
            kind: "Node".into(),
            namespace: None,
            name: "n".into(),
            uid: None,
        };
        assert_eq!(
            event_selector(&involved),
            "involvedObject.kind=Node,involvedObject.name=n"
        );
        involved.namespace = Some("ns".into());
        involved.uid = Some("u".into());
        assert_eq!(
            event_selector(&involved),
            "involvedObject.kind=Node,involvedObject.name=n,involvedObject.namespace=ns,involvedObject.uid=u"
        );
    }

    #[test]
    fn last_seen_takes_the_latest_time_of_any_field() {
        let event = json!({
            "firstTimestamp": "2026-01-01T00:00:00Z",
            "lastTimestamp": "2026-01-03T00:00:00Z",
            "series": { "lastObservedTime": "2026-01-02T00:00:00.000000Z" },
            "metadata": { "creationTimestamp": "2026-01-01T00:00:00Z" },
        });
        assert_eq!(
            last_seen(&event),
            "2026-01-03T00:00:00Z".parse::<Timestamp>().ok()
        );
        assert_eq!(last_seen(&json!({ "lastTimestamp": "soon" })), None);
    }
}
