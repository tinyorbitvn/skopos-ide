//! One-object writes for the agent tools (spec §4.4, §4.5): a patch of a chosen type and a
//! server-side apply of one document, each also as a server-side dry run, which answers with
//! what would be stored and stores nothing. Both write as field manager `skopos-agent` and answer
//! with the object as the API server sends it, Secret values included: the agent gate trims it.
//! These are cluster calls like `resource_apply`, so they work on every OS.

use http::header::{HeaderValue, CONTENT_TYPE};
use kube::api::{Patch, PatchParams};
use kube::core::discovery::Scope;
use kube::core::GroupVersionKind;
use serde::Deserialize;
use serde_json::Value;

use super::apply::{check_identity_types, parse_documents};
use super::ops::{invalid, is_path_segment, object_request, resource_request, send};
use super::types::ResourceRef;
use crate::app_core::AppCore;
use crate::error::CoreResult;
use crate::kubeconfig::ClusterId;

/// Who the API server records as the writer of what the agents change.
const AGENT_FIELD_MANAGER: &str = "skopos-agent";
const JSON_PATCH: &str = "application/json-patch+json";
/// Where a namespaced document without a namespace goes.
const DEFAULT_NAMESPACE: &str = "default";
const ONE_OBJECT: &str = "Apply one object per call.";

/// The patch types of `kubectl patch --type`, named as the `patch_object` tool takes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PatchKind {
    /// RFC 7386: a partial object; `null` removes a field and lists are replaced whole.
    Merge,
    /// Kubernetes' strategic merge: lists of named items merge by their key.
    Strategic,
    /// RFC 6902: a list of operations.
    Json,
}

/// The object one YAML document addresses, resolved through discovery.
pub(crate) struct ApplyTarget {
    pub(crate) resource: ResourceRef,
    /// `None` for a cluster-scoped kind.
    pub(crate) namespace: Option<String>,
    pub(crate) name: String,
    /// The document, with its namespace filled in.
    pub(crate) document: Value,
}

fn text_at(document: &Value, pointer: &str) -> Option<String> {
    document
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `kube` builds JSON patches only with its `jsonpatch` feature. The body of a merge patch of
/// the list is the list itself, so only the media type changes.
fn as_json_patch(mut request: http::Request<Vec<u8>>) -> http::Request<Vec<u8>> {
    request
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(JSON_PATCH));
    request
}

impl AppCore {
    /// Patches one object. A JSON patch is a list of operations, the other types an object.
    // The arguments are those of the `patch_object` tool, plus the dry run.
    #[allow(clippy::too_many_arguments)]
    pub async fn resource_patch(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
        patch: &Value,
        kind: PatchKind,
        dry_run: bool,
    ) -> CoreResult<Value> {
        let request = object_request(r, namespace, name)?;
        match kind {
            PatchKind::Json if !patch.is_array() => {
                return Err(invalid("a JSON patch is a list of operations"))
            }
            PatchKind::Merge | PatchKind::Strategic if !patch.is_object() => {
                return Err(invalid("a merge or strategic patch is an object"))
            }
            _ => {}
        }
        let client = self.cluster_client(id)?;
        let params = PatchParams {
            dry_run,
            field_manager: Some(AGENT_FIELD_MANAGER.to_owned()),
            ..PatchParams::default()
        };
        let built = match kind {
            PatchKind::Merge => request.patch(name, &params, &Patch::Merge(patch)),
            PatchKind::Strategic => request.patch(name, &params, &Patch::Strategic(patch)),
            PatchKind::Json => request
                .patch(name, &params, &Patch::Merge(patch))
                .map(as_json_patch),
        };
        send(&client, built).await
    }

    /// Applies one YAML document with server-side apply and no force, and answers with the
    /// resource, namespace and name it addressed and the object the API server sent back.
    pub async fn resource_apply_one(
        &self,
        id: &ClusterId,
        yaml: &str,
        dry_run: bool,
    ) -> CoreResult<(ResourceRef, Option<String>, String, Value)> {
        let ApplyTarget {
            resource,
            namespace,
            name,
            document,
        } = self.apply_target(id, yaml).await?;
        let request = resource_request(&resource, namespace.as_deref())?;
        let client = self.cluster_client(id)?;
        let params = PatchParams {
            dry_run,
            ..PatchParams::apply(AGENT_FIELD_MANAGER)
        };
        let object = send(
            &client,
            request.patch(&name, &params, &Patch::Apply(&document)),
        )
        .await?;
        Ok((resource, namespace, name, object))
    }

    /// What one YAML document addresses, asking the API server for nothing but its discovery.
    /// Anything but exactly one document is refused; a namespaced object without a namespace
    /// goes to `default`.
    pub(crate) async fn apply_target(&self, id: &ClusterId, yaml: &str) -> CoreResult<ApplyTarget> {
        let mut documents = parse_documents(yaml)?.into_iter();
        let (Some(mut document), None) = (documents.next(), documents.next()) else {
            return Err(invalid(ONE_OBJECT));
        };
        if let Err(message) = check_identity_types(&document) {
            return Err(invalid(message));
        }
        let api_version =
            text_at(&document, "/apiVersion").ok_or_else(|| invalid("apiVersion is required"))?;
        let kind = text_at(&document, "/kind").ok_or_else(|| invalid("kind is required"))?;
        let name = text_at(&document, "/metadata/name")
            .ok_or_else(|| invalid("metadata.name is required"))?;
        if !is_path_segment(&name) {
            return Err(invalid("metadata.name is not a valid object name"));
        }
        let resource = self.served_resource(id, &api_version, &kind).await?;
        let namespace = if resource.namespaced {
            let namespace = text_at(&document, "/metadata/namespace")
                .unwrap_or_else(|| DEFAULT_NAMESPACE.to_owned());
            if !is_path_segment(&namespace) {
                return Err(invalid("the namespace is not valid"));
            }
            if let Some(metadata) = document.get_mut("metadata").and_then(Value::as_object_mut) {
                metadata.insert("namespace".to_owned(), namespace.clone().into());
            }
            Some(namespace)
        } else {
            None
        };
        Ok(ApplyTarget {
            resource,
            namespace,
            name,
            document,
        })
    }

    /// The served resource of `apiVersion` and `kind`, with discovery run again once on a miss.
    async fn served_resource(
        &self,
        id: &ClusterId,
        api_version: &str,
        kind: &str,
    ) -> CoreResult<ResourceRef> {
        let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
        let wanted = GroupVersionKind::gvk(group, version, kind);
        let kept = self.cluster_discovery(id)?.resolve_gvk(&wanted);
        let (resource, capabilities) = match kept {
            Some(found) => found,
            None => self
                .connections()
                .rediscover(id)
                .await?
                .resolve_gvk(&wanted)
                .ok_or_else(|| {
                    invalid(format!(
                        "unknown kind \"{kind}\" in apiVersion \"{api_version}\""
                    ))
                })?,
        };
        Ok(ResourceRef {
            group: resource.group,
            version: resource.version,
            plural: resource.plural,
            kind: resource.kind,
            namespaced: capabilities.scope == Scope::Namespaced,
        })
    }
}
