//! One-object writes for the agent tools (spec §4.4, §4.5). For now, the patch types the
//! `patch_object` tool takes.

use serde::Deserialize;

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
