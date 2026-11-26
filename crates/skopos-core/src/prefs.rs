//! User settings kept in the JSON stores.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::SyncSource;
use crate::metrics::MetricsProviderSetting;

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ClusterSettings {
    pub display_name: Option<String>,
    /// A data URL.
    pub icon: Option<String>,
    pub default_namespace: Option<String>,
    pub accessible_namespaces: Vec<String>,
    pub terminal_cwd: Option<String>,
    pub proxy_url: Option<String>,
    /// The id of the tunnel this cluster is reached through (tunnels spec §5.2). An id that
    /// names no tunnel counts as none.
    pub tunnel: Option<String>,
    pub node_shell_image: Option<String>,
    /// How metrics are read for this cluster (F16).
    pub metrics_provider: MetricsProviderSetting,
    /// How agents work with this cluster (agents spec §3.6).
    pub agent: ClusterAgentSettings,
}

/// What an agent may change in a cluster (agents spec §3.5): `Ask every time` (each change
/// waits for the person's answer), `Read only` (no tool that changes anything) or
/// `Don't ask` (changes run at once).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentChanges {
    #[default]
    Ask,
    ReadOnly,
    DontAsk,
}

/// How agents work with one cluster (agents spec §3.6), saved with its other settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ClusterAgentSettings {
    pub changes: AgentChanges,
    /// The namespaces the agent's tools read and may change. `None`: all of them.
    pub namespaces: Option<Vec<String>>,
    /// When false, the agent sees Secret names and keys, never their values.
    pub secret_values: bool,
    /// Whether the agent may run commands in containers, each one a change.
    pub exec: bool,
    /// Whether the agent may run shell commands in the cluster's Agent terminal, each one a
    /// change (native agents spec §5.2).
    pub terminal: bool,
    /// The agent new chats on this cluster start with. `None`: the app's default.
    pub default_agent: Option<String>,
    /// Sent to the agent at the start of every chat on this cluster.
    pub notes: String,
}

/// The longest notes a cluster can give its agents, in characters (agents spec §3.6).
pub const AGENT_NOTES_MAX: usize = 4_000;

impl ClusterAgentSettings {
    /// Trims the namespaces, sorts them and drops repeats; trims the notes and the default
    /// agent, a blank one being no default. A namespace limit needs at least one namespace,
    /// and the notes may have at most `AGENT_NOTES_MAX` characters.
    pub fn normalized(mut self) -> CoreResult<ClusterAgentSettings> {
        if let Some(namespaces) = self.namespaces.as_mut() {
            let mut kept: Vec<String> = namespaces
                .iter()
                .map(|namespace| namespace.trim().to_owned())
                .filter(|namespace| !namespace.is_empty())
                .collect();
            kept.sort();
            kept.dedup();
            if kept.is_empty() {
                return Err(IpcError::new(
                    ErrorCode::InvalidInput,
                    "Pick at least one namespace.",
                ));
            }
            *namespaces = kept;
        }
        self.notes = self.notes.trim().to_owned();
        if self.notes.chars().count() > AGENT_NOTES_MAX {
            return Err(IpcError::new(
                ErrorCode::InvalidInput,
                "Notes can have at most 4,000 characters.",
            ));
        }
        self.default_agent = self
            .default_agent
            .take()
            .map(|agent| agent.trim().to_owned())
            .filter(|agent| !agent.is_empty());
        Ok(self)
    }
}

/// An agent the person added by command (agents spec §3.5).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct CustomAgent {
    /// `custom-` and 8 hex digits.
    pub id: String,
    pub name: String,
    /// Split as a shell splits it; the first word is the program.
    pub command: String,
}

/// Preferences → Agents (agents spec §3.5, §4.8). Files saved with the sandbox's `domains`
/// and `folders` still read: serde ignores fields it does not know.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AgentPrefs {
    /// The agent new chats start with. `None`: the first Ready agent in list order.
    pub default_agent: Option<String>,
    /// The agents the person added, in the order added.
    pub custom: Vec<CustomAgent>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Theme {
    #[default]
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Prefs {
    pub theme: Theme,
    /// Seeded from `default_sources` on first run. A saved empty list stays empty.
    pub sync_sources: Vec<SyncSource>,
    /// The local terminal's shell. `None` picks one per F11.
    #[ts(optional = nullable)]
    pub terminal_shell: Option<String>,
    /// Used instead of looking helm up (F14). `None`: `PATH`, then the managed copy.
    #[ts(optional = nullable)]
    pub helm_path: Option<String>,
    #[ts(optional = nullable)]
    pub kubectl_path: Option<String>,
    /// For downloads and helm, such as `http://proxy.example:3128`. `None`: the system proxy.
    #[ts(optional = nullable)]
    pub http_proxy: Option<String>,
    /// Look for a new release on launch and every 6 hours (in-app update spec D2).
    pub update_check: bool,
    /// Preferences → Agents (agents spec §4.8). `prefs_set` keeps the
    /// saved value: only the agent calls change it.
    pub agents: AgentPrefs,
}

/// By hand, so that a prefs file saved before `update_check` existed reads it as on.
impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            theme: Theme::default(),
            sync_sources: Vec::new(),
            terminal_shell: None,
            helm_path: None,
            kubectl_path: None,
            http_proxy: None,
            update_check: true,
            agents: AgentPrefs::default(),
        }
    }
}

impl Prefs {
    /// Trims the tool fields and treats blank ones as not set. The proxy must be an http or
    /// https URL.
    pub fn normalized(mut self) -> CoreResult<Prefs> {
        for field in [
            &mut self.helm_path,
            &mut self.kubectl_path,
            &mut self.http_proxy,
        ] {
            *field = field
                .take()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
        }
        if let Some(proxy) = self.http_proxy.as_deref() {
            let valid = url::Url::parse(proxy)
                .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some());
            if !valid {
                // The value is not repeated: it may hold a password.
                return Err(IpcError::new(
                    ErrorCode::InvalidInput,
                    "the HTTP proxy must be an http or https URL, such as http://proxy.example:3128",
                ));
            }
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_serialize_camel_case() {
        let prefs = Prefs {
            theme: Theme::Dark,
            sync_sources: vec![SyncSource::Dir("/h/.kube".into())],
            http_proxy: Some("http://proxy.example:3128".into()),
            ..Prefs::default()
        };
        let v = serde_json::to_value(&prefs).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["syncSources"][0]["kind"], "dir");
        assert_eq!(v["httpProxy"], "http://proxy.example:3128");
        assert!(v["helmPath"].is_null());
    }

    #[test]
    fn blank_tool_fields_are_saved_as_none_and_values_are_trimmed() {
        let prefs = Prefs {
            helm_path: Some("  ".into()),
            kubectl_path: Some(" /usr/local/bin/kubectl ".into()),
            http_proxy: Some("".into()),
            ..Prefs::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(prefs.helm_path, None);
        assert_eq!(
            prefs.kubectl_path.as_deref(),
            Some("/usr/local/bin/kubectl")
        );
        assert_eq!(prefs.http_proxy, None);
    }

    #[test]
    fn only_an_http_or_https_proxy_is_accepted() {
        for good in [
            "http://proxy.example:3128",
            " https://user:pw@proxy.example ",
        ] {
            let prefs = Prefs {
                http_proxy: Some(good.into()),
                ..Prefs::default()
            };
            assert!(prefs.normalized().is_ok(), "{good}");
        }
        for bad in [
            "socks5://proxy.example:1080",
            "proxy.example:3128",
            "http://",
            "not a url",
        ] {
            let prefs = Prefs {
                http_proxy: Some(bad.into()),
                ..Prefs::default()
            };
            let error = prefs.normalized().unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{bad}");
        }
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let prefs: Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs, Prefs::default());
        let settings: ClusterSettings = serde_json::from_str(r#"{"displayName":"Prod"}"#).unwrap();
        assert_eq!(settings.display_name.as_deref(), Some("Prod"));
        assert!(settings.accessible_namespaces.is_empty());
    }

    #[test]
    fn a_prefs_file_without_update_check_turns_checks_on() {
        // What 0.9.0 and earlier saved.
        let old: Prefs = serde_json::from_str(r#"{"theme":"dark","syncSources":[]}"#).unwrap();
        assert!(old.update_check);
        assert_eq!(old.theme, Theme::Dark);
        assert!(Prefs::default().update_check);

        let off: Prefs = serde_json::from_str(r#"{"updateCheck":false}"#).unwrap();
        assert!(!off.update_check);
        assert_eq!(serde_json::to_value(&off).unwrap()["updateCheck"], false);
    }

    #[test]
    fn agent_settings_serialize_in_camel_case() {
        let prefs = AgentPrefs {
            default_agent: Some("codex".into()),
            custom: vec![CustomAgent {
                id: "custom-0a1b2c3d".into(),
                name: "Mine".into(),
                command: "my-agent --acp".into(),
            }],
        };
        let v = serde_json::to_value(&prefs).unwrap();
        assert_eq!(v["defaultAgent"], "codex");
        assert_eq!(v["custom"][0]["id"], "custom-0a1b2c3d");
        assert_eq!(v["custom"][0]["command"], "my-agent --acp");

        let settings = ClusterAgentSettings {
            changes: AgentChanges::ReadOnly,
            secret_values: true,
            default_agent: Some("claude".into()),
            ..ClusterAgentSettings::default()
        };
        let v = serde_json::to_value(&settings).unwrap();
        assert_eq!(v["changes"], "readOnly");
        assert_eq!(v["secretValues"], true);
        assert_eq!(v["exec"], false);
        assert_eq!(v["terminal"], false);
        assert_eq!(v["defaultAgent"], "claude");
        assert!(v["namespaces"].is_null());
        assert_eq!(v["notes"], "");
        assert_eq!(serde_json::to_value(AgentChanges::Ask).unwrap(), "ask");
        assert_eq!(
            serde_json::to_value(AgentChanges::DontAsk).unwrap(),
            "dontAsk"
        );
    }

    #[test]
    fn settings_saved_before_agents_existed_read_the_agent_defaults() {
        // What 0.9.0 saved: no `agents`, no `agent`.
        let old: Prefs =
            serde_json::from_str(r#"{"theme":"dark","syncSources":[],"updateCheck":true}"#)
                .unwrap();
        assert_eq!(old.agents, AgentPrefs::default());
        assert_eq!(Prefs::default().agents, AgentPrefs::default());
        let old: ClusterSettings = serde_json::from_str(r#"{"displayName":"Prod"}"#).unwrap();
        assert_eq!(old.agent, ClusterAgentSettings::default());
        assert_eq!(old.agent.changes, AgentChanges::Ask);

        let partial: ClusterSettings = serde_json::from_str(r#"{"agent":{"exec":true}}"#).unwrap();
        assert!(partial.agent.exec);
        assert_eq!(partial.agent.changes, AgentChanges::Ask);
        assert_eq!(partial.agent.namespaces, None);
        assert_eq!(partial.agent.notes, "");

        let partial: ClusterSettings =
            serde_json::from_str(r#"{"agent":{"terminal":true}}"#).unwrap();
        assert!(partial.agent.terminal);
        assert!(!partial.agent.exec);
    }

    #[test]
    fn agent_settings_tidy_the_namespace_limit_the_notes_and_the_default_agent() {
        let settings = ClusterAgentSettings {
            namespaces: Some(vec![
                " shop ".into(),
                "ingest".into(),
                "shop".into(),
                " ".into(),
            ]),
            notes: "  Argo CD owns the Deployments.\n".into(),
            default_agent: Some("  ".into()),
            ..ClusterAgentSettings::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(
            settings.namespaces,
            Some(vec!["ingest".to_owned(), "shop".to_owned()])
        );
        assert_eq!(settings.notes, "Argo CD owns the Deployments.");
        assert_eq!(settings.default_agent, None);
        assert_eq!(
            ClusterAgentSettings::default().normalized().unwrap(),
            ClusterAgentSettings::default()
        );
    }

    #[test]
    fn a_namespace_limit_needs_a_namespace_and_notes_have_at_most_4000_characters() {
        for namespaces in [Vec::new(), vec!["  ".to_owned()]] {
            let error = ClusterAgentSettings {
                namespaces: Some(namespaces),
                ..ClusterAgentSettings::default()
            }
            .normalized()
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput);
            assert_eq!(error.message, "Pick at least one namespace.");
        }
        // Characters, not bytes.
        let longest = ClusterAgentSettings {
            notes: "é".repeat(4_000),
            ..ClusterAgentSettings::default()
        };
        assert!(longest.normalized().is_ok());
        let error = ClusterAgentSettings {
            notes: "é".repeat(4_001),
            ..ClusterAgentSettings::default()
        }
        .normalized()
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.message, "Notes can have at most 4,000 characters.");
    }

    #[test]
    fn old_agent_prefs_with_domains_and_folders_still_read() {
        let text = r#"{"agents":{"defaultAgent":"claude","custom":[{"id":"custom-0000e2e0","name":"Fake","command":"fake --acp"}],"domains":["example.com"],"folders":["~/src"]}}"#;
        let prefs: Prefs = serde_json::from_str(text).unwrap();
        assert_eq!(prefs.agents.default_agent.as_deref(), Some("claude"));
        assert_eq!(prefs.agents.custom.len(), 1);
        let saved = serde_json::to_string(&prefs).unwrap();
        assert!(
            !saved.contains("domains") && !saved.contains("folders"),
            "{saved}"
        );
    }
}
