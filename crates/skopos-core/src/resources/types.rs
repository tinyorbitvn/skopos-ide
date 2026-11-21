//! Types describing a served API resource and the events of a watch on one.

use std::sync::Arc;

use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;
use ts_rs::TS;

/// Identifies one resource type by group, version and plural.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    pub group: String,
    pub version: String,
    pub plural: String,
    pub kind: String,
    pub namespaced: bool,
}

/// A served resource with what the current user may do with it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ApiResourceInfo {
    pub resource: ResourceRef,
    pub verbs: Vec<String>,
    pub short_names: Vec<String>,
    pub can_list: bool,
    pub can_watch: bool,
    pub can_create: bool,
    pub can_update: bool,
    pub can_patch: bool,
    pub can_delete: bool,
}

/// Identifies one object within a resource type.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ObjectKey {
    pub namespace: Option<String>,
    pub name: String,
}

/// The health of a watch. `NotServed` and `Forbidden` are final: nothing more
/// arrives on that subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum WatchStatus {
    Syncing,
    Live,
    Reconnecting,
    NotServed,
    Forbidden,
}

/// One watched object, kept as the JSON text it crosses to the webview as. Parsed,
/// an object costs about ten times its text, and the hub never reads inside one.
/// Clones share the text.
#[derive(Debug, Clone)]
pub struct Row(Arc<RawValue>);

impl Row {
    pub fn new(object: &serde_json::Value) -> serde_json::Result<Self> {
        serde_json::value::to_raw_value(object).map(|raw| Self(raw.into()))
    }

    pub fn json(&self) -> &str {
        self.0.get()
    }

    /// Parses the text again, for a reader that needs the fields.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::from_str(self.0.get()).expect("a row holds the JSON of a value")
    }
}

/// Writes the text as it is, so the object reaches the webview unchanged.
impl Serialize for Row {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// The most rows one event of a snapshot carries to the webview.
pub const SNAPSHOT_PART_ROWS: usize = 2_000;
/// The most row text, in bytes, one event of a snapshot carries, unless one row is larger.
pub const SNAPSHOT_PART_BYTES: usize = 2 * 1024 * 1024;

/// What a subscriber receives. A `Snapshot` replaces everything it holds, and a
/// `Batch` changes it. A `SnapshotPart` holds the first rows of a snapshot that the next
/// event continues: a large snapshot is cut into these on its way to the webview.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WatchEvent {
    SnapshotPart {
        #[ts(as = "Vec<serde_json::Value>")]
        items: Vec<Row>,
    },
    Snapshot {
        #[ts(as = "Vec<serde_json::Value>")]
        items: Vec<Row>,
    },
    Batch {
        #[ts(as = "Vec<serde_json::Value>")]
        upserts: Vec<Row>,
        deletes: Vec<ObjectKey>,
    },
    Status {
        status: WatchStatus,
        message: Option<String>,
    },
}

impl WatchEvent {
    /// The events that carry this one to the webview, in order. A large snapshot is cut,
    /// so the webview parses it a part at a time: `SnapshotPart`s, then a `Snapshot` of the
    /// last rows. Any other event goes as it is.
    pub fn into_parts(self) -> Vec<WatchEvent> {
        let items = match self {
            WatchEvent::Snapshot { items } => items,
            other => return vec![other],
        };
        let mut parts = Vec::new();
        let mut part = Vec::new();
        let mut bytes = 0;
        for row in items {
            let size = row.json().len();
            let full = part.len() >= SNAPSHOT_PART_ROWS || bytes + size > SNAPSHOT_PART_BYTES;
            if full && !part.is_empty() {
                let items = std::mem::take(&mut part);
                parts.push(WatchEvent::SnapshotPart { items });
                bytes = 0;
            }
            bytes += size;
            part.push(row);
        }
        parts.push(WatchEvent::Snapshot { items: part });
        parts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str) -> Row {
        Row::new(&serde_json::json!({ "metadata": { "name": name } })).unwrap()
    }

    fn rows(count: usize) -> Vec<Row> {
        (0..count).map(|n| row(&format!("pod-{n}"))).collect()
    }

    /// Each event's kind and how many rows it carries.
    fn shape(events: &[WatchEvent]) -> Vec<(&'static str, usize)> {
        events
            .iter()
            .map(|event| match event {
                WatchEvent::SnapshotPart { items } => ("part", items.len()),
                WatchEvent::Snapshot { items } => ("snapshot", items.len()),
                WatchEvent::Batch { upserts, .. } => ("batch", upserts.len()),
                WatchEvent::Status { .. } => ("status", 0),
            })
            .collect()
    }

    fn names(events: &[WatchEvent]) -> Vec<String> {
        events
            .iter()
            .flat_map(|event| match event {
                WatchEvent::SnapshotPart { items } | WatchEvent::Snapshot { items } => {
                    items.clone()
                }
                _ => Vec::new(),
            })
            .map(|row| {
                row.to_value()["metadata"]["name"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn a_snapshot_within_one_part_goes_as_it_is() {
        let whole = WatchEvent::Snapshot {
            items: rows(SNAPSHOT_PART_ROWS),
        };
        assert_eq!(
            shape(&whole.into_parts()),
            [("snapshot", SNAPSHOT_PART_ROWS)]
        );

        let empty = WatchEvent::Snapshot { items: Vec::new() };
        assert_eq!(shape(&empty.into_parts()), [("snapshot", 0)]);
    }

    #[test]
    fn a_snapshot_of_many_rows_is_cut_and_ends_with_a_snapshot() {
        let whole = WatchEvent::Snapshot { items: rows(4_500) };
        let sent: Vec<String> = names(std::slice::from_ref(&whole));

        let parts = whole.into_parts();

        assert_eq!(
            shape(&parts),
            [("part", 2_000), ("part", 2_000), ("snapshot", 500)]
        );
        assert_eq!(names(&parts), sent, "every row once, in the order sent");
    }

    #[test]
    fn a_snapshot_of_large_rows_is_cut_by_their_size() {
        // Rows of about 0.9 MiB each: two fit in a part, and a third does not.
        let large = "x".repeat(SNAPSHOT_PART_BYTES * 45 / 100);
        let items: Vec<Row> = (0..5)
            .map(|n| Row::new(&serde_json::json!({ "n": n, "data": large })).unwrap())
            .collect();

        let parts = WatchEvent::Snapshot { items }.into_parts();

        assert_eq!(shape(&parts), [("part", 2), ("part", 2), ("snapshot", 1)]);
    }

    #[test]
    fn a_row_larger_than_a_part_goes_alone() {
        let huge = "x".repeat(SNAPSHOT_PART_BYTES + 1);
        let items = vec![
            row("before"),
            Row::new(&serde_json::json!({ "data": huge })).unwrap(),
            row("after"),
        ];

        let parts = WatchEvent::Snapshot { items }.into_parts();

        assert_eq!(shape(&parts), [("part", 1), ("part", 1), ("snapshot", 1)]);
    }

    #[test]
    fn a_batch_and_a_status_go_as_they_are() {
        let batch = WatchEvent::Batch {
            upserts: rows(SNAPSHOT_PART_ROWS + 1),
            deletes: Vec::new(),
        };
        assert_eq!(
            shape(&batch.into_parts()),
            [("batch", SNAPSHOT_PART_ROWS + 1)]
        );

        let status = WatchEvent::Status {
            status: WatchStatus::Live,
            message: None,
        };
        assert_eq!(shape(&status.into_parts()), [("status", 0)]);
    }
}
