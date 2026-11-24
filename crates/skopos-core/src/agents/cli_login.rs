//! The sign-in an agent's CLI keeps in the macOS keychain, read by the app outside the sandbox
//! and handed to that agent alone. The sandbox hides the keychains: an item that
//! `/usr/bin/security` made opens to any process that runs it, so an agent that read them would
//! see other CLIs' tokens too. Only the item's access token goes to the agent; its refresh token
//! stays in the keychain, so the agent cannot rotate it and sign the person's own CLI out.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::agents::registry::{keychain_login, AgentSpec};
use crate::process::{self, Output, ProcessSpec};

/// macOS's keychain command.
pub const SECURITY: &str = "/usr/bin/security";
const TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 64 * 1024;
/// A token with less than this left is not handed over: the chat would stop at its first turn.
const MARGIN_MS: f64 = 5.0 * 60.0 * 1000.0;

/// Where a built-in agent's CLI keeps its sign-in in the keychain, as Claude Code's JSON, and
/// the variable that hands its access token to the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeychainLogin {
    /// The service of the generic password item.
    pub service: &'static str,
    pub var: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    claude_ai_oauth: Option<OAuth>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuth {
    access_token: Option<String>,
    /// Milliseconds since the epoch.
    expires_at: Option<f64>,
}

/// Milliseconds since the epoch, now.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The access token in `item`, the keychain item's text, while more than `MARGIN_MS` of it is
/// left at `now_ms`; a token without an end is handed over. `None` for any other text.
pub fn access_token(item: &str, now_ms: i64) -> Option<String> {
    let item: Item = serde_json::from_str(item.trim()).ok()?;
    let oauth = item.claude_ai_oauth?;
    let token = oauth
        .access_token
        .filter(|token| !token.trim().is_empty())?;
    match oauth.expires_at {
        Some(end) if end - now_ms as f64 <= MARGIN_MS => None,
        _ => Some(token),
    }
}

/// `login`'s access token, read with `security` (an argument array and a timeout): `None` when
/// the item is missing or cannot be read, or its token has run out. The item's text never
/// reaches a log or an error.
pub async fn keychain_token(security: &Path, login: &KeychainLogin, now_ms: i64) -> Option<String> {
    let spec = ProcessSpec::new(
        security,
        ["find-generic-password", "-s", login.service, "-w"],
        TIMEOUT,
    );
    let output = Output::Capture {
        stdout_limit: OUTPUT_LIMIT,
        stderr_limit: OUTPUT_LIMIT,
    };
    let output = process::run(spec, output, CancellationToken::new())
        .await
        .ok()?;
    if !output.success() || output.stdout_truncated {
        return None;
    }
    access_token(std::str::from_utf8(&output.stdout).ok()?, now_ms)
}

/// The variable and token that hand `agent` its CLI's sign-in: for a built-in agent whose CLI
/// keeps it in the keychain, unless `get`, the app's environment, gives one of its provider
/// keys, which the agent gets instead.
pub async fn agent_login(
    agent: &AgentSpec,
    get: &(dyn Fn(&str) -> Option<String> + Sync),
    security: &Path,
    now_ms: i64,
) -> Option<(String, String)> {
    let login = keychain_login(agent)?;
    if agent.key_vars.iter().any(|name| get(name).is_some()) {
        return None;
    }
    let token = keychain_token(security, login, now_ms).await?;
    Some((login.var.to_owned(), token))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn item(token: &str, expires_at: i64) -> String {
        serde_json::json!({
            "claudeAiOauth": {
                "accessToken": token,
                "refreshToken": "refresh-secret",
                "expiresAt": expires_at,
                "scopes": ["user:inference"],
                "subscriptionType": "max"
            },
            "mcpOAuth": { "server": { "accessToken": "mcp-secret" } }
        })
        .to_string()
    }

    #[test]
    fn the_access_token_is_handed_over_while_it_has_time_left() {
        assert_eq!(
            access_token(&item("sk-ant-oat01-abc", NOW + 7 * HOUR), NOW).as_deref(),
            Some("sk-ant-oat01-abc")
        );
        assert_eq!(
            access_token(&format!("{}\n", item("t", NOW + HOUR)), NOW).as_deref(),
            Some("t")
        );
        // Run out, or about to.
        assert_eq!(access_token(&item("t", NOW - HOUR), NOW), None);
        assert_eq!(access_token(&item("t", NOW + 60_000), NOW), None);
        // No end: handed over.
        let lasting = r#"{"claudeAiOauth":{"accessToken":"t"}}"#;
        assert_eq!(access_token(lasting, NOW).as_deref(), Some("t"));
    }

    #[test]
    fn any_other_text_gives_no_token() {
        for text in [
            "",
            "not json",
            "{}",
            r#"{"claudeAiOauth":{}}"#,
            r#"{"claudeAiOauth":{"accessToken":"  "}}"#,
            r#"{"mcpOAuth":{"accessToken":"mcp-secret"}}"#,
        ] {
            assert_eq!(access_token(text, NOW), None, "{text}");
        }
    }

    #[cfg(unix)]
    mod with_a_fake_security {
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;

        use super::*;
        use crate::agents::sandbox::test_agent;

        /// A `security` that prints `item` for Claude Code's item and fails otherwise, and
        /// leaves a mark in `dir` when it runs.
        fn fake_security(dir: &Path, item: &str) -> PathBuf {
            let path = dir.join("security");
            std::fs::write(dir.join("item"), item).unwrap();
            let script = format!(
                "#!/bin/sh\ntouch '{mark}'\n\
                 [ \"$*\" = 'find-generic-password -s Claude Code-credentials -w' ] || exit 44\n\
                 cat '{item}'\n",
                mark = dir.join("ran").display(),
                item = dir.join("item").display(),
            );
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn claude() -> AgentSpec {
            let mut agent = test_agent(Path::new("/bin/claude-agent-acp"));
            agent.id = "claude".to_owned();
            agent.custom = false;
            agent.key_vars = vec![
                "ANTHROPIC_API_KEY".to_owned(),
                "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            ];
            agent
        }

        #[tokio::test]
        async fn claude_gets_its_cli_access_token_as_its_oauth_variable() {
            let dir = tempfile::tempdir().unwrap();
            let security = fake_security(dir.path(), &item("sk-ant-oat01-abc", NOW + HOUR));
            let none = |_: &str| None;
            assert_eq!(
                agent_login(&claude(), &none, &security, NOW).await,
                Some((
                    "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
                    "sk-ant-oat01-abc".to_owned()
                ))
            );
            // Run out: nothing, and the chat asks for a sign-in.
            assert_eq!(
                agent_login(&claude(), &none, &security, NOW + 2 * HOUR).await,
                None
            );
        }

        #[tokio::test]
        async fn a_key_the_person_set_wins_and_the_keychain_is_not_read() {
            let dir = tempfile::tempdir().unwrap();
            let security = fake_security(dir.path(), &item("t", NOW + HOUR));
            let key = |name: &str| (name == "ANTHROPIC_API_KEY").then(|| "sk-ant-api".to_owned());
            assert_eq!(agent_login(&claude(), &key, &security, NOW).await, None);
            assert!(!dir.path().join("ran").exists());
        }

        #[tokio::test]
        async fn other_agents_and_a_missing_item_give_nothing() {
            let dir = tempfile::tempdir().unwrap();
            let security = fake_security(dir.path(), &item("t", NOW + HOUR));
            let none = |_: &str| None;
            let mut custom = claude();
            custom.custom = true;
            assert_eq!(agent_login(&custom, &none, &security, NOW).await, None);
            let mut codex = claude();
            codex.id = "codex".to_owned();
            assert_eq!(agent_login(&codex, &none, &security, NOW).await, None);
            assert!(!dir.path().join("ran").exists());
            let missing = KeychainLogin {
                service: "Other-credentials",
                var: "CLAUDE_CODE_OAUTH_TOKEN",
            };
            assert_eq!(keychain_token(&security, &missing, NOW).await, None);
            let absent = dir.path().join("no-security");
            assert_eq!(agent_login(&claude(), &none, &absent, NOW).await, None);
        }
    }
}
