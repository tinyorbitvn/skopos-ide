//! The sign-in an agent's CLI keeps in the macOS keychain, read by the app outside the sandbox
//! and handed to that agent alone. The sandbox hides the keychains: an item that
//! `/usr/bin/security` made opens to any process that runs it, so an agent that read them would
//! see other CLIs' tokens too. Only the item's access token goes to the agent; its refresh token
//! stays in the keychain, so the agent cannot rotate it and sign the person's own CLI out. The
//! access token runs out after some hours, while the CLI renews the item whenever it runs, so a
//! chat reads the item again once the token it was handed has run out.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::agents::registry::{keychain_login, AgentSpec};
use crate::process::{self, Output, ProcessSpec};

/// macOS's keychain command.
pub const SECURITY: &str = "/usr/bin/security";
const TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 64 * 1024;
/// A token with less than this left counts as run out: the chat would stop at its next turn.
const MARGIN_MS: i64 = 5 * 60 * 1000;

/// Where a built-in agent's CLI keeps its sign-in in the keychain, as Claude Code's JSON, the
/// variable that hands its access token to the agent, and how to renew it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeychainLogin {
    /// The service of the generic password item.
    pub service: &'static str,
    pub var: &'static str,
    /// The steps a chat's sign-in notice gives when the item's token has run out too.
    pub hint: &'static str,
}

/// An access token and when it runs out, in milliseconds since the epoch; `None` for no end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessToken {
    pub value: String,
    pub ends_ms: Option<i64>,
}

/// Where a chat reads its agent's sign-in: the `security` program and the item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainSource {
    pub security: PathBuf,
    pub login: KeychainLogin,
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

/// Whether a token that ends at `ends_ms` has run out at `now_ms`, or is about to.
fn runs_out(ends_ms: Option<i64>, now_ms: i64) -> bool {
    ends_ms.is_some_and(|end| end.saturating_sub(now_ms) <= MARGIN_MS)
}

/// The access token in `item`, the keychain item's text, unless it has run out at `now_ms`; a
/// token without an end is kept. `None` for any other text.
pub fn access_token(item: &str, now_ms: i64) -> Option<AccessToken> {
    let item: Item = serde_json::from_str(item.trim()).ok()?;
    let oauth = item.claude_ai_oauth?;
    let value = oauth
        .access_token
        .filter(|token| !token.trim().is_empty())?;
    // `as` saturates, so a huge or odd end never wraps.
    let ends_ms = oauth.expires_at.map(|end| end as i64);
    (!runs_out(ends_ms, now_ms)).then_some(AccessToken { value, ends_ms })
}

/// Whether a chat that was handed `handed` (`None`: no token) needs a new one at `now_ms`:
/// it has none, or its token has run out or is about to.
pub fn needs_renewal(handed: Option<&AccessToken>, now_ms: i64) -> bool {
    handed.is_none_or(|token| runs_out(token.ends_ms, now_ms))
}

impl KeychainSource {
    /// macOS's `security` and the item of `agent`, a built-in agent whose CLI keeps its sign-in
    /// in the keychain, unless `get`, the app's environment, gives one of its provider keys,
    /// which the agent gets instead.
    pub fn for_agent(
        agent: &AgentSpec,
        get: &dyn Fn(&str) -> Option<String>,
    ) -> Option<KeychainSource> {
        let login = keychain_login(agent)?;
        if agent.key_vars.iter().any(|name| get(name).is_some()) {
            return None;
        }
        Some(KeychainSource {
            security: PathBuf::from(SECURITY),
            login: *login,
        })
    }

    /// The item's access token, read with `security` (an argument array and a timeout):
    /// `None` when the item is missing or cannot be read, or its token has run out. The item's
    /// text never reaches a log or an error.
    pub async fn token(&self, now_ms: i64) -> Option<AccessToken> {
        read_token(&self.security, &self.login, now_ms).await
    }
}

async fn read_token(security: &Path, login: &KeychainLogin, now_ms: i64) -> Option<AccessToken> {
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

    fn token(value: &str, ends_ms: Option<i64>) -> AccessToken {
        AccessToken {
            value: value.to_owned(),
            ends_ms,
        }
    }

    #[test]
    fn the_access_token_is_kept_with_its_end_while_it_has_time_left() {
        assert_eq!(
            access_token(&item("sk-ant-oat01-abc", NOW + 7 * HOUR), NOW),
            Some(token("sk-ant-oat01-abc", Some(NOW + 7 * HOUR)))
        );
        assert_eq!(
            access_token(&format!("{}\n", item("t", NOW + HOUR)), NOW),
            Some(token("t", Some(NOW + HOUR)))
        );
        // Run out, or about to.
        assert_eq!(access_token(&item("t", NOW - HOUR), NOW), None);
        assert_eq!(access_token(&item("t", NOW + 60_000), NOW), None);
        // No end: kept.
        let lasting = r#"{"claudeAiOauth":{"accessToken":"t"}}"#;
        assert_eq!(access_token(lasting, NOW), Some(token("t", None)));
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

    #[test]
    fn a_chat_needs_a_new_token_once_its_own_has_run_out_or_it_has_none() {
        assert!(needs_renewal(None, NOW));
        assert!(needs_renewal(Some(&token("t", Some(NOW - HOUR))), NOW));
        assert!(needs_renewal(Some(&token("t", Some(NOW + 60_000))), NOW));
        assert!(!needs_renewal(Some(&token("t", Some(NOW + HOUR))), NOW));
        assert!(!needs_renewal(Some(&token("t", None)), NOW));
    }

    #[cfg(unix)]
    mod with_a_fake_security {
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;

        use super::*;
        use crate::agents::sandbox::test_agent;

        const CLAUDE_LOGIN: KeychainLogin = KeychainLogin {
            service: "Claude Code-credentials",
            var: "CLAUDE_CODE_OAUTH_TOKEN",
            hint: "Run claude in a terminal to renew its sign-in, then send your message again.",
        };

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

        fn source(security: PathBuf, login: KeychainLogin) -> KeychainSource {
            KeychainSource { security, login }
        }

        #[test]
        fn claude_reads_its_cli_item_unless_the_person_set_a_key() {
            let none = |_: &str| None;
            assert_eq!(
                KeychainSource::for_agent(&claude(), &none),
                Some(source(PathBuf::from(SECURITY), CLAUDE_LOGIN))
            );
            for name in ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] {
                let key = |given: &str| (given == name).then(|| "sk-ant-api".to_owned());
                assert_eq!(KeychainSource::for_agent(&claude(), &key), None, "{name}");
            }
        }

        #[test]
        fn other_agents_read_no_item() {
            let none = |_: &str| None;
            let mut custom = claude();
            custom.custom = true;
            assert_eq!(KeychainSource::for_agent(&custom, &none), None);
            let mut codex = claude();
            codex.id = "codex".to_owned();
            assert_eq!(KeychainSource::for_agent(&codex, &none), None);
        }

        #[tokio::test]
        async fn the_item_gives_its_access_token_while_it_has_time_left() {
            let dir = tempfile::tempdir().unwrap();
            let security = fake_security(dir.path(), &item("sk-ant-oat01-abc", NOW + HOUR));
            let claude = source(security.clone(), CLAUDE_LOGIN);
            assert_eq!(
                claude.token(NOW).await,
                Some(token("sk-ant-oat01-abc", Some(NOW + HOUR)))
            );
            // Run out: nothing, and the chat asks for a sign-in.
            assert_eq!(claude.token(NOW + 2 * HOUR).await, None);
        }

        #[tokio::test]
        async fn a_missing_item_or_security_gives_nothing() {
            let dir = tempfile::tempdir().unwrap();
            let security = fake_security(dir.path(), &item("t", NOW + HOUR));
            let other = KeychainLogin {
                service: "Other-credentials",
                ..CLAUDE_LOGIN
            };
            assert_eq!(source(security, other).token(NOW).await, None);
            assert!(dir.path().join("ran").exists());
            let absent = source(dir.path().join("no-security"), CLAUDE_LOGIN);
            assert_eq!(absent.token(NOW).await, None);
        }
    }
}
