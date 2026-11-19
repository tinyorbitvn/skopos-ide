//! One kind's API docs, read from the cluster's OpenAPI v3 (spec L).

mod cache;
mod fetch;
mod tree;
mod types;

use std::sync::Arc;

use kube::Client;

pub(crate) use cache::ApiDocs;
pub use types::{KindSchema, SchemaField};

use crate::app_core::AppCore;
use crate::blocking::blocking;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::invalid;

/// The answer to an apiVersion that is neither form (spec L2).
const BAD_API_VERSION: &str = "apiVersion must read ‹version› or ‹group›/‹version›.";
const NO_KIND: &str = "kind is empty.";

/// What `api_schema` looks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    /// As asked, which the messages quote and the result carries.
    pub(crate) api_version: String,
    /// "" for the core group.
    pub(crate) group: String,
    pub(crate) version: String,
    pub(crate) kind: String,
}

impl Target {
    /// `‹version›` or `‹group›/‹version›` with no spaces, and a non-empty kind (spec L2).
    pub(crate) fn parse(api_version: &str, kind: &str) -> CoreResult<Target> {
        let (group, version) = match api_version.split('/').collect::<Vec<_>>().as_slice() {
            [version] => ("", *version),
            [group, version] if !group.is_empty() => (*group, *version),
            _ => return Err(invalid(BAD_API_VERSION)),
        };
        if version.is_empty() || api_version.chars().any(char::is_whitespace) {
            return Err(invalid(BAD_API_VERSION));
        }
        let kind = kind.trim();
        if kind.is_empty() {
            return Err(invalid(NO_KIND));
        }
        Ok(Target {
            api_version: api_version.to_owned(),
            group: group.to_owned(),
            version: version.to_owned(),
            kind: kind.to_owned(),
        })
    }

    /// The group version's key in `/openapi/v3`'s `paths` (spec L3).
    pub(crate) fn key(&self) -> String {
        if self.group.is_empty() {
            format!("api/{}", self.version)
        } else {
            format!("apis/{}/{}", self.group, self.version)
        }
    }
}

/// What one look, in the cache or at the cluster, found.
enum Lookup {
    Found(Arc<KindSchema>),
    /// The index names no document for the group version, or the document moved or went.
    NoDocument,
    /// The document has no schema for the kind.
    NoKind,
}

impl AppCore {
    /// One kind's API docs (spec L1). Every request goes through the cluster's client (L12).
    /// What was read is kept until the cluster disconnects (L5); a miss reads the index once
    /// more before it is an error (L6, L13).
    pub async fn api_schema(
        &self,
        id: &ClusterId,
        api_version: &str,
        kind: &str,
    ) -> CoreResult<KindSchema> {
        let target = Target::parse(api_version, kind)?;
        let epoch = self.connections().epoch(id)?;
        let client = self.cluster_client(id)?;
        let mut found = self.look_up(&client, id, epoch, &target, false).await?;
        if !matches!(found, Lookup::Found(_)) {
            found = self.look_up(&client, id, epoch, &target, true).await?;
        }
        match found {
            Lookup::Found(schema) => Ok(KindSchema::clone(&schema)),
            Lookup::NoDocument => Err(IpcError::new(
                ErrorCode::NotFound,
                format!(
                    "The cluster publishes no API docs for {}.",
                    target.api_version
                ),
            )),
            Lookup::NoKind => Err(IpcError::new(
                ErrorCode::NotFound,
                format!(
                    "The API docs for {} have no {}.",
                    target.api_version, target.kind
                ),
            )),
        }
    }

    /// One look: the index (kept, or read again when `fresh_index`), then the built schema,
    /// the kept document, or a GET of the document.
    async fn look_up(
        &self,
        client: &Client,
        id: &ClusterId,
        epoch: u64,
        target: &Target,
        fresh_index: bool,
    ) -> CoreResult<Lookup> {
        let docs = self.api_docs();
        let kept = if fresh_index {
            None
        } else {
            docs.index(id, epoch)
        };
        let index = match kept {
            Some(index) => index,
            None => {
                let (status, body) = fetch::get(client, fetch::INDEX_PATH).await?;
                let index = fetch::read_index(status, body, target.api_version.clone()).await?;
                docs.store_index(id, epoch, index)
            }
        };
        let Some(url) = index.url(&target.key()).map(str::to_owned) else {
            return Ok(Lookup::NoDocument);
        };
        if let Some(schema) = docs.schema(id, epoch, &url, &target.kind) {
            return Ok(Lookup::Found(schema));
        }
        let document = match docs.document(id, epoch, &url) {
            Some(document) => document,
            None => {
                let (status, body) = fetch::get(client, &url).await?;
                match fetch::read_document(status, body, target.api_version.clone()).await? {
                    Some(document) => docs.store_document(id, epoch, &url, document),
                    None => return Ok(Lookup::NoDocument),
                }
            }
        };
        let schema = {
            let (document, target) = (std::sync::Arc::clone(&document), target.clone());
            blocking(move || Ok(tree::kind_schema(&document, &target))).await?
        };
        Ok(match schema {
            Some(schema) => Lookup::Found(docs.store_schema(id, epoch, &url, &target.kind, schema)),
            None => Lookup::NoKind,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri commands await `api_schema` on a multi-threaded runtime, so its future must be
    /// `Send` whatever the borrows' lifetimes. This fails to compile when it is not.
    #[allow(dead_code)]
    fn api_schema_is_send<'a>(
        core: &'a AppCore,
        id: &'a ClusterId,
        api_version: &'a str,
        kind: &'a str,
    ) {
        fn send<T: Send>(_: &T) {}
        send(&core.api_schema(id, api_version, kind));
    }

    #[test]
    fn an_api_version_is_a_version_or_a_group_and_a_version() {
        let core = Target::parse("v1", "ConfigMap").unwrap();
        assert_eq!((core.group.as_str(), core.version.as_str()), ("", "v1"));
        assert_eq!(core.key(), "api/v1");
        let apps = Target::parse("apps/v1", " Deployment ").unwrap();
        assert_eq!(
            (
                apps.api_version.as_str(),
                apps.group.as_str(),
                apps.version.as_str()
            ),
            ("apps/v1", "apps", "v1")
        );
        assert_eq!(apps.kind, "Deployment");
        assert_eq!(apps.key(), "apis/apps/v1");
    }

    #[test]
    fn anything_else_is_refused_with_the_spec_text() {
        for bad in ["", "/v1", "apps/", "a/b/c", "apps /v1", " v1"] {
            let err = Target::parse(bad, "Kind").unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{bad:?}");
            assert_eq!(
                err.message, "apiVersion must read ‹version› or ‹group›/‹version›.",
                "{bad:?}"
            );
        }
        for kind in ["", "  "] {
            let err = Target::parse("v1", kind).unwrap_err();
            assert_eq!(
                (err.code, err.message.as_str()),
                (ErrorCode::InvalidInput, "kind is empty.")
            );
        }
    }
}
