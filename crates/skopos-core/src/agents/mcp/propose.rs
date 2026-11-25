//! `propose_yaml` (YAML authoring spec A10): the agent's new text for the chat's YAML tab,
//! checked and dry-run, shown to the person as a proposal. It writes nothing to the cluster,
//! so the change gate does not apply.

use std::sync::Arc;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use serde_json::{json, Value};

use super::changes::{limit_text, one_line};
use super::trim::namespace_allowed;
use super::ToolContext;
use crate::agents::diff::text_diff;
use crate::agents::editor_tab::{
    restore_values, tab_namespaces, EditTarget, EditorTabMode, TAB_TEXT_CAP,
};
use crate::agents::tabs::{ProposalCard, ProposalState};
use crate::cluster::ConnectionState;
use crate::resources::parse_documents;
use crate::sessions::random_hex;

pub(super) const PROPOSE_YAML: &str = "propose_yaml";
const DESCRIPTION: &str = "Propose new text for the YAML tab the person is working in: the whole text, which the person accepts or rejects in the tab. It is checked with a server dry run and writes nothing. Values shown as (hidden) keep the tab's values.";
pub(super) const NO_TAB: &str =
    "No YAML tab is attached to this chat; ask the person to use Ask AI in a create or edit tab.";

pub(super) fn propose_tool() -> Tool {
    let mut schema = JsonObject::new();
    schema.insert("type".into(), "object".into());
    schema.insert(
        "properties".into(),
        json!({
            "yaml": { "type": "string", "description": "The tab's whole new text: one or more YAML documents." },
            "summary": { "type": "string", "maxLength": 200, "description": "One line for the person: what the proposal changes and why." },
        }),
    );
    schema.insert("required".into(), json!(["yaml", "summary"]));
    Tool::new(PROPOSE_YAML, DESCRIPTION, Arc::new(schema))
}

fn tool_error(text: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}

fn read_args(args: &JsonObject) -> Result<(String, String), String> {
    let yaml = args
        .get("yaml")
        .and_then(Value::as_str)
        .ok_or("Give the tab's whole new text as yaml.")?;
    if yaml.len() > TAB_TEXT_CAP {
        return Err("The proposal is over 64 KiB.".to_owned());
    }
    let summary = args
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if summary.trim().is_empty() {
        return Err("Give a one-line summary of the proposal.".to_owned());
    }
    Ok((yaml.to_owned(), summary.to_owned()))
}

fn group_of(api_version: &str) -> &str {
    api_version.split_once('/').map_or("", |(group, _)| group)
}

/// Spec A10 step 3: an edit tab's proposal is one document of the same object.
fn same_object(documents: &[Value], target: &EditTarget) -> Result<(), String> {
    let text = |document: &Value, pointer: &str| {
        document
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let wanted = match &target.namespace {
        Some(namespace) => format!("{} {namespace}/{}", target.resource.kind, target.name),
        None => format!("{} {}", target.resource.kind, target.name),
    };
    let refusal = || format!("The proposal must keep editing {wanted}, as one document.");
    let [document] = documents else {
        return Err(refusal());
    };
    let same = text(document, "/apiVersion").as_deref().map(group_of)
        == Some(target.resource.group.as_str())
        && text(document, "/kind").as_deref() == Some(target.resource.kind.as_str())
        && text(document, "/metadata/name").as_deref() == Some(target.name.as_str())
        && text(document, "/metadata/namespace") == target.namespace;
    if same {
        Ok(())
    } else {
        Err(refusal())
    }
}

/// The (group, kind) each CRD in the text defines.
fn crd_kinds(documents: &[Value]) -> Vec<(String, String)> {
    documents
        .iter()
        .filter(|d| d.get("kind").and_then(Value::as_str) == Some("CustomResourceDefinition"))
        .filter(|d| {
            d.get("apiVersion").and_then(Value::as_str).map(group_of)
                == Some("apiextensions.k8s.io")
        })
        .filter_map(|d| {
            let group = d.pointer("/spec/group")?.as_str()?;
            let kind = d.pointer("/spec/names/kind")?.as_str()?;
            Some((group.to_owned(), kind.to_owned()))
        })
        .collect()
}

pub(super) async fn call_propose(ctx: &ToolContext, args: JsonObject) -> CallToolResult {
    match propose(ctx, &args).await {
        Ok(title) => CallToolResult::success(vec![ContentBlock::text(format!(
            "Shown to the person as a proposal for \"{title}\"; they accept or reject it."
        ))]),
        Err(text) => tool_error(text),
    }
}

async fn propose(ctx: &ToolContext, args: &JsonObject) -> Result<String, String> {
    let (yaml, summary) = read_args(args)?;
    let attached = ctx.tabs.attached().ok_or(NO_TAB)?;
    let tab = &attached.tab;
    let documents = parse_documents(&yaml).map_err(|error| error.message)?;
    if documents.is_empty() {
        return Err("The proposal is empty.".to_owned());
    }
    if tab.mode == EditorTabMode::Edit {
        let target = tab
            .target
            .as_ref()
            .ok_or("This edit tab names no object.")?;
        same_object(&documents, target)?;
    }
    let restored = restore_values(&yaml, &attached.hidden)?;
    let cluster = &attached.cluster;
    if !matches!(
        ctx.core.cluster_state(&cluster.id),
        ConnectionState::Connected { .. }
    ) {
        return Err(super::changes::not_connected_text(&cluster.name));
    }
    // Namespace limits run in core on every call: the dry run's messages can quote stored
    // values, so a namespace the agent may not read is refused before it.
    let settings = ctx.core.cluster_agent_settings(&cluster.id);
    if let Some(allowed) = &settings.namespaces {
        let mut restored_tab = tab.clone();
        restored_tab.yaml = restored.clone();
        if tab_namespaces(&ctx.core, &restored_tab)
            .iter()
            .any(|namespace| !namespace_allowed(&settings, namespace))
        {
            return Err(limit_text(&cluster.name, allowed));
        }
    }
    match (&tab.mode, &tab.target) {
        (EditorTabMode::Edit, Some(target)) => {
            ctx.core
                .resource_replace_dry_run(
                    &cluster.id,
                    &target.resource,
                    target.namespace.as_deref(),
                    &target.name,
                    &restored,
                )
                .await
                .map_err(|error| error.message)?;
        }
        _ => {
            let defined = crd_kinds(&documents);
            let results = ctx
                .core
                .resource_apply_dry_run(&cluster.id, &restored, &tab.default_namespace)
                .await
                .map_err(|error| error.message)?;
            for result in results.iter().filter(|result| !result.ok) {
                let document = documents.get(result.index as usize);
                let kind = result.kind.clone().unwrap_or_default();
                let group = document
                    .and_then(|d| d.get("apiVersion"))
                    .and_then(Value::as_str)
                    .map(group_of)
                    .unwrap_or_default();
                if result.message.contains("unknown kind")
                    && defined.iter().any(|(g, k)| g == group && *k == kind)
                {
                    continue;
                }
                return Err(format!(
                    "Document {} ({} {}): {}",
                    result.index + 1,
                    kind,
                    result.name.clone().unwrap_or_default(),
                    result.message
                ));
            }
        }
    }
    let (diff, added, removed) = text_diff(&tab.yaml, &restored);
    let card = ProposalCard {
        id: format!("proposal-{}", random_hex()),
        tab_id: tab.tab_id.clone(),
        tab_title: tab.title.clone(),
        cluster: cluster.name.clone(),
        cluster_id: cluster.id.clone(),
        mode: tab.mode,
        target: tab.target.clone(),
        summary: one_line(&summary),
        added,
        removed,
        state: ProposalState::Waiting,
        yaml: restored,
        diff,
    };
    let title = card.tab_title.clone();
    ctx.tabs.propose(card).await;
    Ok(title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::ResourceRef;

    #[test]
    fn the_same_object_check_compares_group_kind_name_and_namespace() {
        let target = EditTarget {
            resource: ResourceRef {
                group: "apps".into(),
                version: "v1".into(),
                plural: "deployments".into(),
                kind: "Deployment".into(),
                namespaced: true,
            },
            namespace: Some("shop".into()),
            name: "web".into(),
        };
        let same = serde_json::json!({ "apiVersion": "apps/v1beta2", "kind": "Deployment", "metadata": { "name": "web", "namespace": "shop" } });
        assert!(same_object(&[same], &target).is_ok());
        let renamed = serde_json::json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { "name": "api", "namespace": "shop" } });
        assert_eq!(
            same_object(&[renamed], &target).unwrap_err(),
            "The proposal must keep editing Deployment shop/web, as one document."
        );
    }

    #[test]
    fn crd_kinds_are_read_from_the_text() {
        let crd = serde_json::json!({ "apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition", "spec": { "group": "e2e.example", "names": { "kind": "Widget" } } });
        assert_eq!(
            crd_kinds(&[crd]),
            vec![("e2e.example".to_owned(), "Widget".to_owned())]
        );
    }

    #[test]
    fn arguments_over_the_caps_are_refused() {
        let mut args = JsonObject::new();
        args.insert("yaml".into(), "a".repeat(TAB_TEXT_CAP + 1).into());
        args.insert("summary".into(), "s".into());
        assert_eq!(
            read_args(&args).unwrap_err(),
            "The proposal is over 64 KiB."
        );
        args.insert("yaml".into(), "a: b\n".into());
        args.insert("summary".into(), " ".into());
        assert_eq!(
            read_args(&args).unwrap_err(),
            "Give a one-line summary of the proposal."
        );
    }
}
