//! The text block that starts a chat's first prompt, which the stream does not show, and the
//! line an attached object adds (spec §4.3).

use crate::agents::editor_tab::{EditTarget, EditorTabMode};
use crate::prefs::ClusterAgentSettings;

/// The intro, around what the chat reaches: one cluster's name, or `these clusters: <a, b>`.
const INTRO_START: &str =
    "You are running inside SkoposIDE, a Kubernetes desktop app. You can reach ";
const INTRO_END: &str =
    " only through the tools of the skopos MCP server; there is no kubectl and \
    no kubeconfig in your sandbox. Reads run at once. A change may wait for the person's approval, \
    and the person may deny it. Before a change, read the object and say what you will change.";

/// The clusters of one chat with their agent settings, in the chat's order.
pub struct PromptContext {
    pub clusters: Vec<(String, ClusterAgentSettings)>,
    /// A global chat reaches every cluster it lists; a per-cluster chat lists one.
    pub global: bool,
}

/// The hidden block: the intro; then the limits, one line each, per cluster in order (its
/// namespaces, then its hidden Secret values); then, per cluster with notes, `Notes from the
/// person about <cluster>:` and the notes, trimmed. Paragraphs are separated by a blank line;
/// one with nothing in it is left out.
pub fn hidden_block(ctx: &PromptContext) -> String {
    let names: Vec<&str> = ctx.clusters.iter().map(|(name, _)| name.as_str()).collect();
    let reach = if ctx.global {
        format!("these clusters: {}", names.join(", "))
    } else {
        names.first().copied().unwrap_or_default().to_owned()
    };
    let mut paragraphs = vec![format!("{INTRO_START}{reach}{INTRO_END}")];
    let mut limits: Vec<String> = Vec::new();
    for (name, settings) in &ctx.clusters {
        if let Some(namespaces) = &settings.namespaces {
            limits.push(format!(
                "On {name} you may see only these namespaces: {}.",
                namespaces.join(", ")
            ));
        }
        if !settings.secret_values {
            limits.push(format!("On {name} Secret values are hidden."));
        }
    }
    if !limits.is_empty() {
        paragraphs.push(limits.join("\n"));
    }
    for (name, settings) in &ctx.clusters {
        let notes = settings.notes.trim();
        if !notes.is_empty() {
            paragraphs.push(format!("Notes from the person about {name}:\n{notes}"));
        }
    }
    paragraphs.join("\n\n")
}

/// `The person is asking about <Kind> <namespace>/<name> on <cluster>.`; a cluster-scoped
/// object has no `<namespace>/`.
pub fn object_line(kind: &str, namespace: Option<&str>, name: &str, cluster: &str) -> String {
    match namespace {
        Some(namespace) => {
            format!("The person is asking about {kind} {namespace}/{name} on {cluster}.")
        }
        None => format!("The person is asking about {kind} {name} on {cluster}."),
    }
}

/// What the agent is told about the tab a prompt carries (YAML authoring spec A9).
pub struct TabView<'a> {
    pub mode: EditorTabMode,
    pub title: &'a str,
    /// The cluster's name in the chat.
    pub cluster: &'a str,
    pub target: Option<&'a EditTarget>,
    /// The text as the agent may see it.
    pub text: &'a str,
    /// Some values show as `(hidden)`.
    pub hidden: bool,
}

/// The tab's block: what it is, its text fenced, and how to change it.
pub fn tab_block(view: &TabView) -> String {
    let mode = match view.mode {
        EditorTabMode::Create => "create",
        EditorTabMode::Edit => "edit",
    };
    let editing = match view.target {
        Some(target) => match &target.namespace {
            Some(namespace) => format!(
                ", editing {} {namespace}/{}",
                target.resource.kind, target.name
            ),
            None => format!(", editing {} {}", target.resource.kind, target.name),
        },
        None => String::new(),
    };
    // A fence longer than any run of backticks in the text.
    let longest = view
        .text
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    let text = view.text.strip_suffix('\n').unwrap_or(view.text);
    let mut block = format!(
        "The person is working in a YAML {mode} tab, \"{}\", on {}{editing}. Its text now:\n{fence}yaml\n{text}\n{fence}\nTo change the tab, call propose_yaml with the whole new text and a one-line summary; the person accepts or rejects it in the tab. Do not apply it with apply_object unless the person asks.",
        view.title, view.cluster,
    );
    if view.hidden {
        block.push_str(" Values shown as (hidden) are kept from the tab as they are; leave them as (hidden) to keep them.");
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::editor_tab::{EditTarget, EditorTabMode};
    use crate::resources::ResourceRef;

    #[test]
    fn a_create_tab_block_fences_the_text_and_asks_for_propose_yaml() {
        let block = tab_block(&TabView {
            mode: EditorTabMode::Create,
            title: "New Service · NodePort",
            cluster: "kind",
            target: None,
            text: "kind: Service\n",
            hidden: false,
        });
        assert_eq!(
            block,
            "The person is working in a YAML create tab, \"New Service · NodePort\", on kind. Its text now:\n```yaml\nkind: Service\n```\nTo change the tab, call propose_yaml with the whole new text and a one-line summary; the person accepts or rejects it in the tab. Do not apply it with apply_object unless the person asks."
        );
    }

    #[test]
    fn an_edit_tab_block_names_the_object_and_the_hidden_values() {
        let target = EditTarget {
            resource: ResourceRef {
                group: String::new(),
                version: "v1".into(),
                plural: "secrets".into(),
                kind: "Secret".into(),
                namespaced: true,
            },
            namespace: Some("shop".into()),
            name: "db".into(),
        };
        let block = tab_block(&TabView {
            mode: EditorTabMode::Edit,
            title: "Secret shop/db",
            cluster: "kind",
            target: Some(&target),
            text: "data:\n  a: (hidden)\n```\n",
            hidden: true,
        });
        assert!(block.starts_with("The person is working in a YAML edit tab, \"Secret shop/db\", on kind, editing Secret shop/db. Its text now:\n````yaml\n"));
        assert!(block.ends_with(" Values shown as (hidden) are kept from the tab as they are; leave them as (hidden) to keep them."));
    }

    /// The intro typed out from spec §4.3, with `reach` filled in.
    fn intro(reach: &str) -> String {
        format!(
            "You are running inside SkoposIDE, a Kubernetes desktop app. You can reach {reach} \
             only through the tools of the skopos MCP server; there is no kubectl and no \
             kubeconfig in your sandbox. Reads run at once. A change may wait for the person's \
             approval, and the person may deny it. Before a change, read the object and say what \
             you will change."
        )
    }

    fn cluster(name: &str, settings: ClusterAgentSettings) -> (String, ClusterAgentSettings) {
        (name.to_owned(), settings)
    }

    #[test]
    fn a_cluster_with_default_settings_gets_the_intro_and_hidden_secret_values() {
        let ctx = PromptContext {
            clusters: vec![cluster("prod-eu-west", ClusterAgentSettings::default())],
            global: false,
        };
        assert_eq!(
            hidden_block(&ctx),
            "You are running inside SkoposIDE, a Kubernetes desktop app. You can reach prod-eu-west only through the tools of the skopos MCP server; there is no kubectl and no kubeconfig in your sandbox. Reads run at once. A change may wait for the person's approval, and the person may deny it. Before a change, read the object and say what you will change.\n\nOn prod-eu-west Secret values are hidden."
        );
    }

    #[test]
    fn namespace_limits_then_notes_follow_the_intro() {
        let settings = ClusterAgentSettings {
            namespaces: Some(vec!["ingest".to_owned(), "payments".to_owned()]),
            secret_values: true,
            notes: "  Deploys go through Argo CD.\n".to_owned(),
            ..ClusterAgentSettings::default()
        };
        let ctx = PromptContext {
            clusters: vec![cluster("prod-eu-west", settings)],
            global: false,
        };
        assert_eq!(
            hidden_block(&ctx),
            format!(
                "{}\n\nOn prod-eu-west you may see only these namespaces: ingest, payments.\n\n\
                 Notes from the person about prod-eu-west:\nDeploys go through Argo CD.",
                intro("prod-eu-west")
            )
        );
    }

    #[test]
    fn both_limits_of_one_cluster_come_namespaces_first() {
        let settings = ClusterAgentSettings {
            namespaces: Some(vec!["kube-system".to_owned()]),
            ..ClusterAgentSettings::default()
        };
        let ctx = PromptContext {
            clusters: vec![cluster("dev", settings)],
            global: false,
        };
        assert_eq!(
            hidden_block(&ctx),
            format!(
                "{}\n\nOn dev you may see only these namespaces: kube-system.\n\
                 On dev Secret values are hidden.",
                intro("dev")
            )
        );
    }

    #[test]
    fn a_global_chat_names_every_cluster_and_keeps_their_order() {
        let staging = ClusterAgentSettings {
            notes: "Staging is rebuilt every night.".to_owned(),
            ..ClusterAgentSettings::default()
        };
        let prod = ClusterAgentSettings {
            namespaces: Some(vec!["web".to_owned()]),
            secret_values: true,
            ..ClusterAgentSettings::default()
        };
        let ctx = PromptContext {
            clusters: vec![cluster("staging", staging), cluster("prod", prod)],
            global: true,
        };
        assert_eq!(
            hidden_block(&ctx),
            format!(
                "{}\n\nOn staging Secret values are hidden.\n\
                 On prod you may see only these namespaces: web.\n\n\
                 Notes from the person about staging:\nStaging is rebuilt every night.",
                intro("these clusters: staging, prod")
            )
        );
    }

    #[test]
    fn readable_secrets_without_limits_or_notes_leave_only_the_intro() {
        let settings = ClusterAgentSettings {
            secret_values: true,
            notes: " \n ".to_owned(),
            ..ClusterAgentSettings::default()
        };
        let ctx = PromptContext {
            clusters: vec![cluster("dev", settings)],
            global: false,
        };
        assert_eq!(hidden_block(&ctx), intro("dev"));
    }

    #[test]
    fn the_object_line_names_the_kind_its_namespace_and_name_and_the_cluster() {
        assert_eq!(
            object_line(
                "Pod",
                Some("payments"),
                "api-7d9f8c6b5-x2kqp",
                "prod-eu-west"
            ),
            "The person is asking about Pod payments/api-7d9f8c6b5-x2kqp on prod-eu-west."
        );
        assert_eq!(
            object_line("Node", None, "worker-1", "prod"),
            "The person is asking about Node worker-1 on prod."
        );
    }
}
