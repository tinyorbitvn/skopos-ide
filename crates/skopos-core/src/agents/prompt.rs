//! The text block that starts a chat's first prompt, which the stream does not show, and the
//! line an attached object adds (spec §4.3).

use std::path::{Path, PathBuf};

use crate::agents::editor_tab::{EditTarget, EditorTabMode};
use crate::prefs::ClusterAgentSettings;

/// The intro: what the chat reaches (`reach`), and the chat's own kubeconfig with its contexts
/// (`names`); the clusters left out of it (`outside`) are named for the skopos tools only.
fn intro(reach: &str, kubeconfig: &Path, names: &[&str], outside: &[String]) -> String {
    let holds = if names.is_empty() {
        "That file holds no contexts.".to_owned()
    } else {
        format!(
            "That file holds only these contexts, each named after its cluster: {}.",
            names.join(", ")
        )
    };
    let tools_only = if outside.is_empty() {
        String::new()
    } else {
        format!(
            " Reach {} only through the skopos tools.",
            outside.join(", ")
        )
    };
    format!(
        "You are running inside SkoposIDE, a Kubernetes desktop app, on the person's computer. \
         You can reach {reach} through the tools of the skopos MCP server, and through your own \
         shell, where KUBECONFIG is set to {path}. {holds}{tools_only} For kubectl, helm and any \
         other Kubernetes client, use only that kubeconfig and those contexts. Never use \
         ~/.kube/config, another kubeconfig file or another context, and never change \
         KUBECONFIG or pass --kubeconfig or --context for another cluster. Prefer the skopos \
         tools: reads run at once, and a change may wait for the person's approval, and the \
         person may deny it. Keep to the limits below in your own commands too. Before a change, \
         read the object and say what you will change.",
        path = kubeconfig.display(),
    )
}

/// The clusters of one chat with their agent settings, in the chat's order.
pub struct PromptContext {
    pub clusters: Vec<(String, ClusterAgentSettings)>,
    /// A global chat reaches every cluster it lists; a per-cluster chat lists one.
    pub global: bool,
    /// The chat's own kubeconfig, the only one the agent may use.
    pub kubeconfig: PathBuf,
    /// The chat's clusters left out of that kubeconfig, because their kubeconfig runs a command
    /// for credentials that the person has not allowed.
    pub outside: Vec<String>,
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
    let in_file: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| !ctx.outside.iter().any(|left| left == name))
        .collect();
    let mut paragraphs = vec![intro(&reach, &ctx.kubeconfig, &in_file, &ctx.outside)];
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
    const KUBECONFIG: &str = "/run/chat/kubeconfig";

    fn intro_for(reach: &str, names: &[&str]) -> String {
        super::intro(reach, Path::new(KUBECONFIG), names, &[])
    }

    fn cluster(name: &str, settings: ClusterAgentSettings) -> (String, ClusterAgentSettings) {
        (name.to_owned(), settings)
    }

    #[test]
    fn a_cluster_with_default_settings_gets_the_intro_and_hidden_secret_values() {
        let ctx = PromptContext {
            clusters: vec![cluster("prod-eu-west", ClusterAgentSettings::default())],
            global: false,
            kubeconfig: PathBuf::from(KUBECONFIG),
            outside: vec![],
        };
        assert_eq!(
            hidden_block(&ctx),
            format!(
                "{}\n\nOn prod-eu-west Secret values are hidden.",
                intro_for("prod-eu-west", &["prod-eu-west"])
            )
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
            kubeconfig: PathBuf::from(KUBECONFIG),
            outside: vec![],
        };
        assert_eq!(
            hidden_block(&ctx),
            format!(
                "{}\n\nOn prod-eu-west you may see only these namespaces: ingest, payments.\n\n\
                 Notes from the person about prod-eu-west:\nDeploys go through Argo CD.",
                intro_for("prod-eu-west", &["prod-eu-west"])
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
            kubeconfig: PathBuf::from(KUBECONFIG),
            outside: vec![],
        };
        assert_eq!(
            hidden_block(&ctx),
            format!(
                "{}\n\nOn dev you may see only these namespaces: kube-system.\n\
                 On dev Secret values are hidden.",
                intro_for("dev", &["dev"])
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
            kubeconfig: PathBuf::from(KUBECONFIG),
            outside: vec![],
        };
        assert_eq!(
            hidden_block(&ctx),
            format!(
                "{}\n\nOn staging Secret values are hidden.\n\
                 On prod you may see only these namespaces: web.\n\n\
                 Notes from the person about staging:\nStaging is rebuilt every night.",
                intro_for("these clusters: staging, prod", &["staging", "prod"])
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
            kubeconfig: PathBuf::from(KUBECONFIG),
            outside: vec![],
        };
        assert_eq!(hidden_block(&ctx), intro_for("dev", &["dev"]));
    }

    #[test]
    fn the_intro_names_the_chat_kubeconfig_and_its_contexts() {
        let ctx = PromptContext {
            clusters: vec![
                cluster("prod", ClusterAgentSettings::default()),
                cluster("stage", ClusterAgentSettings::default()),
            ],
            global: true,
            kubeconfig: PathBuf::from("/run/chat/kubeconfig"),
            outside: vec![],
        };
        let block = hidden_block(&ctx);
        assert!(
            block.contains("KUBECONFIG is set to /run/chat/kubeconfig"),
            "{block}"
        );
        assert!(
            block.contains("each named after its cluster: prod, stage."),
            "{block}"
        );
        assert!(block.contains("Never use ~/.kube/config"), "{block}");
        assert!(!block.contains("sandbox"), "{block}");
    }

    #[test]
    fn a_cluster_left_out_of_the_kubeconfig_is_reached_only_through_the_tools() {
        let ctx = PromptContext {
            clusters: vec![
                cluster("prod", ClusterAgentSettings::default()),
                cluster("eks", ClusterAgentSettings::default()),
            ],
            global: true,
            kubeconfig: PathBuf::from(KUBECONFIG),
            outside: vec!["eks".into()],
        };
        let block = hidden_block(&ctx);
        assert!(
            block.contains("these clusters: prod, eks through"),
            "{block}"
        );
        assert!(
            block.contains(
                "each named after its cluster: prod. Reach eks only through the skopos tools. For kubectl"
            ),
            "{block}"
        );
    }

    #[test]
    fn a_kubeconfig_without_contexts_says_so() {
        let ctx = PromptContext {
            clusters: vec![cluster("eks", ClusterAgentSettings::default())],
            global: false,
            kubeconfig: PathBuf::from(KUBECONFIG),
            outside: vec!["eks".into()],
        };
        let block = hidden_block(&ctx);
        assert!(
            block.contains(
                "That file holds no contexts. Reach eks only through the skopos tools. For kubectl"
            ),
            "{block}"
        );
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
