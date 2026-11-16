//! What `api_schema` keeps per cluster until it disconnects (spec L5).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;

use super::fetch::Index;
use super::types::KindSchema;
use crate::kubeconfig::ClusterId;

/// The most group version documents one cluster keeps; the least recently used goes first.
pub(crate) const MAX_DOCUMENTS: usize = 16;

/// The index, documents and built schemas of each connected cluster.
#[derive(Default)]
pub(crate) struct ApiDocs {
    clusters: Mutex<HashMap<ClusterId, ClusterDocs>>,
}

/// One cluster's, read on the connection numbered `epoch`.
#[derive(Default)]
struct ClusterDocs {
    epoch: u64,
    /// `/openapi/v3`, kept until a lookup misses (spec L6).
    index: Option<Arc<Index>>,
    /// Documents by URL, least recently used first.
    documents: VecDeque<(String, Arc<Value>)>,
    /// Built schemas by document URL and kind; they go when their document goes.
    schemas: HashMap<(String, String), Arc<KindSchema>>,
}

impl ApiDocs {
    /// Runs `f` on the cluster's entry, emptied first when it was read on another connection.
    fn with<T>(&self, id: &ClusterId, epoch: u64, f: impl FnOnce(&mut ClusterDocs) -> T) -> T {
        let mut clusters = self.clusters.lock().unwrap_or_else(PoisonError::into_inner);
        let docs = clusters.entry(id.clone()).or_default();
        if docs.epoch != epoch {
            *docs = ClusterDocs {
                epoch,
                ..ClusterDocs::default()
            };
        }
        f(docs)
    }

    pub(crate) fn index(&self, id: &ClusterId, epoch: u64) -> Option<Arc<Index>> {
        self.with(id, epoch, |docs| docs.index.clone())
    }

    pub(crate) fn store_index(&self, id: &ClusterId, epoch: u64, index: Index) -> Arc<Index> {
        let index = Arc::new(index);
        self.with(id, epoch, |docs| docs.index = Some(Arc::clone(&index)));
        index
    }

    /// The document at `url`, which becomes the most recently used.
    pub(crate) fn document(&self, id: &ClusterId, epoch: u64, url: &str) -> Option<Arc<Value>> {
        self.with(id, epoch, |docs| {
            let at = docs.documents.iter().position(|(kept, _)| kept == url)?;
            let entry = docs.documents.remove(at)?;
            let document = Arc::clone(&entry.1);
            docs.documents.push_back(entry);
            Some(document)
        })
    }

    /// Keeps the document at `url`. Past `MAX_DOCUMENTS`, the least recently used goes, and
    /// the schemas built from it go too.
    pub(crate) fn store_document(
        &self,
        id: &ClusterId,
        epoch: u64,
        url: &str,
        document: Value,
    ) -> Arc<Value> {
        let document = Arc::new(document);
        self.with(id, epoch, |docs| {
            docs.documents.retain(|(kept, _)| kept != url);
            docs.documents
                .push_back((url.to_owned(), Arc::clone(&document)));
            while docs.documents.len() > MAX_DOCUMENTS {
                if let Some((dropped, _)) = docs.documents.pop_front() {
                    docs.schemas.retain(|(of, _), _| *of != dropped);
                }
            }
        });
        document
    }

    pub(crate) fn schema(
        &self,
        id: &ClusterId,
        epoch: u64,
        url: &str,
        kind: &str,
    ) -> Option<Arc<KindSchema>> {
        self.with(id, epoch, |docs| {
            docs.schemas
                .get(&(url.to_owned(), kind.to_owned()))
                .cloned()
        })
    }

    pub(crate) fn store_schema(
        &self,
        id: &ClusterId,
        epoch: u64,
        url: &str,
        kind: &str,
        schema: KindSchema,
    ) -> Arc<KindSchema> {
        let schema = Arc::new(schema);
        self.with(id, epoch, |docs| {
            docs.schemas
                .insert((url.to_owned(), kind.to_owned()), Arc::clone(&schema));
        });
        schema
    }

    /// Drops everything kept for the cluster, as a disconnect does (spec L5).
    pub(crate) fn forget(&self, id: &ClusterId) {
        self.clusters
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn id(name: &str) -> ClusterId {
        name.to_owned()
    }

    fn schema(kind: &str) -> KindSchema {
        KindSchema {
            api_version: "v1".into(),
            kind: kind.into(),
            description: String::new(),
            fields: Vec::new(),
            truncated: false,
        }
    }

    #[test]
    fn what_was_read_is_kept_for_its_connection_only() {
        let docs = ApiDocs::default();
        let c1 = id("c1");
        docs.store_index(&c1, 1, Index::default());
        docs.store_document(&c1, 1, "/a", json!({ "a": 1 }));
        docs.store_schema(&c1, 1, "/a", "Thing", schema("Thing"));
        assert!(docs.index(&c1, 1).is_some());
        assert_eq!(*docs.document(&c1, 1, "/a").unwrap(), json!({ "a": 1 }));
        assert_eq!(docs.schema(&c1, 1, "/a", "Thing").unwrap().kind, "Thing");
        assert!(docs.schema(&c1, 1, "/a", "Other").is_none());

        // Another connection starts afresh, and the old one's entries are gone for good.
        assert!(docs.index(&c1, 2).is_none());
        assert!(docs.document(&c1, 2, "/a").is_none());
        assert!(docs.index(&c1, 1).is_none());
    }

    #[test]
    fn documents_keep_the_sixteen_most_recently_used() {
        let docs = ApiDocs::default();
        let c1 = id("c1");
        for n in 0..MAX_DOCUMENTS {
            docs.store_document(&c1, 1, &format!("/d{n}"), json!(n));
        }
        docs.store_schema(&c1, 1, "/d1", "Thing", schema("Thing"));
        // Reading /d0 makes it the most recently used, so /d1 is now the oldest.
        assert!(docs.document(&c1, 1, "/d0").is_some());
        docs.store_document(&c1, 1, "/d16", json!(16));
        assert!(docs.document(&c1, 1, "/d0").is_some());
        assert!(docs.document(&c1, 1, "/d1").is_none());
        assert!(docs.schema(&c1, 1, "/d1", "Thing").is_none());
        assert!(docs.document(&c1, 1, "/d16").is_some());
    }

    #[test]
    fn forget_drops_one_cluster() {
        let docs = ApiDocs::default();
        docs.store_index(&id("c1"), 1, Index::default());
        docs.store_index(&id("c2"), 1, Index::default());
        docs.forget(&id("c1"));
        assert!(docs.index(&id("c1"), 1).is_none());
        assert!(docs.index(&id("c2"), 1).is_some());
    }
}
