//! SkoposIDE's tools for agents (spec §4.4): one MCP server named `skopos` per chat, its
//! read tools, and the seam where the change tools and their gate join.

pub mod cards;
pub mod changes;
pub mod kinds;
pub mod server;
mod tools;
pub mod trim;

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::app_core::AppCore;
use crate::kubeconfig::ClusterId;
use crate::resources::PatchKind;

pub use cards::{CardDetails, CardTone, ToolCard};
pub use server::serve_mcp;

/// One cluster a chat's tools reach, under the name the agent uses for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeCluster {
    pub id: ClusterId,
    /// The catalog name, with ` (2)`, ` (3)` after a repeated one.
    pub name: String,
}

/// The clusters of one chat: one for a per-cluster chat, or each cluster of a global chat,
/// whose tools then take a `cluster` argument.
#[derive(Debug, Clone)]
pub struct ToolScope {
    pub clusters: Vec<ScopeCluster>,
    pub global: bool,
}

/// The clusters under the names a chat shows: a repeated catalog name gets ` (2)`,
/// ` (3)` and so on, skipping a name already taken.
pub fn scope_names(entries: &[(ClusterId, String)]) -> Vec<ScopeCluster> {
    let mut taken = HashSet::new();
    entries
        .iter()
        .map(|(id, name)| {
            let mut shown = name.clone();
            let mut number = 2;
            while !taken.insert(shown.clone()) {
                shown = format!("{name} ({number})");
                number += 1;
            }
            ScopeCluster {
                id: id.clone(),
                name: shown,
            }
        })
        .collect()
}

/// What one chat's MCP server works with.
pub struct ToolContext {
    pub core: AppCore,
    pub scope: ToolScope,
    /// Each tool call's card, running and then done.
    pub cards: mpsc::Sender<ToolCard>,
    pub gate: Arc<dyn ChangeGate>,
}

/// Decides and runs one change an agent asks for (spec §4.5).
pub trait ChangeGate: Send + Sync {
    fn decide(
        &self,
        request: ChangeRequest,
    ) -> Pin<Box<dyn Future<Output = ChangeOutcome> + Send + '_>>;
}

/// One call of a change tool, its arguments read.
#[derive(Debug, Clone)]
pub struct ChangeRequest {
    pub cluster: ScopeCluster,
    pub tool: ChangeTool,
    /// The agent's one-line description, shown on the card.
    pub summary: String,
}

#[derive(Debug, Clone)]
pub enum ChangeTool {
    Apply {
        yaml: String,
    },
    Patch {
        kind: String,
        namespace: Option<String>,
        name: String,
        patch: Value,
        patch_type: PatchKind,
    },
    Scale {
        kind: String,
        namespace: String,
        name: String,
        replicas: i32,
    },
    Restart {
        kind: String,
        namespace: String,
        name: String,
    },
    Delete {
        kind: String,
        namespace: Option<String>,
        name: String,
    },
    Exec {
        namespace: String,
        pod: String,
        container: Option<String>,
        command: Vec<String>,
        timeout_seconds: u64,
    },
}

/// What a change tool returns to the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeOutcome {
    Applied { text: String },
    Refused { text: String },
}

/// A gate that refuses every change.
pub struct NoChanges;

impl ChangeGate for NoChanges {
    fn decide(
        &self,
        request: ChangeRequest,
    ) -> Pin<Box<dyn Future<Output = ChangeOutcome> + Send + '_>> {
        Box::pin(std::future::ready(ChangeOutcome::Refused {
            text: format!(
                "Changes to {} are read only for agents.",
                request.cluster.name
            ),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(names: &[&str]) -> Vec<(ClusterId, String)> {
        names
            .iter()
            .enumerate()
            .map(|(n, name)| (n.to_string(), (*name).to_owned()))
            .collect()
    }

    #[test]
    fn repeated_names_get_a_number() {
        let scope = scope_names(&entries(&["prod", "dev", "prod", "prod"]));
        let names: Vec<&str> = scope.iter().map(|cluster| cluster.name.as_str()).collect();
        assert_eq!(names, ["prod", "dev", "prod (2)", "prod (3)"]);
        assert_eq!(scope[2].id, "2");
    }

    #[test]
    fn a_name_that_looks_numbered_is_not_given_twice() {
        let scope = scope_names(&entries(&["prod", "prod (2)", "prod"]));
        let names: Vec<&str> = scope.iter().map(|cluster| cluster.name.as_str()).collect();
        assert_eq!(names, ["prod", "prod (2)", "prod (3)"]);
    }

    #[tokio::test]
    async fn no_changes_refuses_every_change() {
        let request = ChangeRequest {
            cluster: ScopeCluster {
                id: "a".repeat(32),
                name: "prod".to_owned(),
            },
            tool: ChangeTool::Restart {
                kind: "Deployment".to_owned(),
                namespace: "shop".to_owned(),
                name: "web".to_owned(),
            },
            summary: "Restart web".to_owned(),
        };
        assert_eq!(
            NoChanges.decide(request).await,
            ChangeOutcome::Refused {
                text: "Changes to prod are read only for agents.".to_owned()
            }
        );
    }
}
