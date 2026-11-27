//! The tunnel definitions kept in `tunnels.json` (tunnels spec §5.2) and their checks.

use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use url::Url;

use crate::error::{CoreResult, ErrorCode, IpcError};

/// The longest tunnel name, in characters.
pub const NAME_MAX: usize = 64;
pub const PROXY_URL_ERROR: &str =
    "Use http://, https:// or socks5:// with a host and an optional port";
pub const PROXY_USERINFO_ERROR: &str = "Put the user name and password in their own fields";
pub const SSH_HOST_NEEDED: &str = "A host is needed.";
pub const SSH_PORT_ERROR: &str = "The port is a number from 1 to 65535.";
pub const SSH_IDENTITY_ERROR: &str = "The identity file must be an absolute path.";

/// The fields of an SSH tunnel, borrowed from its `TunnelKind::Ssh`.
// Read by the ssh runner of a later task; remove the allow there.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SshFields<'a> {
    pub(crate) host: &'a str,
    pub(crate) user: Option<&'a str>,
    pub(crate) port: Option<u16>,
    pub(crate) jump: Option<&'a str>,
    pub(crate) identity_file: Option<&'a str>,
}

/// A field `ssh` reads as the word after an option, so it may never be read as an option
/// itself (spec §6.2, T5).
fn ssh_word(text: &str, label: &str) -> CoreResult<()> {
    if text.starts_with('-') || text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid(format!(
            "{label} cannot start with \"-\" or hold spaces or control characters."
        )));
    }
    Ok(())
}

/// Trimmed, and `None` when blank.
fn trimmed(field: Option<String>) -> Option<String> {
    field
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

/// How a tunnel reaches the private network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum TunnelKind {
    /// An existing HTTP, HTTPS or SOCKS5 proxy. Its password is in the keychain (spec §5.3).
    #[serde(rename_all = "camelCase")]
    Proxy {
        /// `scheme://host[:port]`, as `proxy_url` returns it.
        url: String,
        username: Option<String>,
    },
    /// The system `ssh` with a dynamic forward (spec §6.2). Empty fields come from
    /// `~/.ssh/config`; the app never reads `identity_file` itself (T6).
    #[serde(rename_all = "camelCase")]
    Ssh {
        host: String,
        user: Option<String>,
        port: Option<u16>,
        jump: Option<String>,
        identity_file: Option<String>,
    },
}

impl TunnelKind {
    /// Trims and checks the fields (spec §5.1).
    pub fn normalized(self) -> CoreResult<TunnelKind> {
        match self {
            TunnelKind::Proxy { url, username } => {
                let url = proxy_url(&url)?;
                let username = username
                    .map(|user| user.trim().to_owned())
                    .filter(|user| !user.is_empty());
                if username
                    .as_deref()
                    .is_some_and(|user| user.contains(':') || user.chars().any(char::is_control))
                {
                    return Err(invalid(
                        "A user name cannot hold \":\" or control characters.",
                    ));
                }
                Ok(TunnelKind::Proxy { url, username })
            }
            TunnelKind::Ssh {
                host,
                user,
                port,
                jump,
                identity_file,
            } => {
                let host = host.trim().to_owned();
                if host.is_empty() {
                    return Err(invalid(SSH_HOST_NEEDED));
                }
                ssh_word(&host, "The host")?;
                let user = trimmed(user);
                if let Some(user) = &user {
                    ssh_word(user, "The user")?;
                }
                let jump = trimmed(jump);
                if let Some(jump) = &jump {
                    ssh_word(jump, "The jump host")?;
                }
                if port == Some(0) {
                    return Err(invalid(SSH_PORT_ERROR));
                }
                let identity_file = trimmed(identity_file);
                let bad_identity = identity_file.as_deref().is_some_and(|path| {
                    !Path::new(path).is_absolute() || path.chars().any(char::is_control)
                });
                if bad_identity {
                    return Err(invalid(SSH_IDENTITY_ERROR));
                }
                Ok(TunnelKind::Ssh {
                    host,
                    user,
                    port,
                    jump,
                    identity_file,
                })
            }
        }
    }

    /// Stands for the tunnel in the exec approval fingerprint in place of `proxy-url`: its kind
    /// and target, never its name, token or password (spec §5.7).
    pub(crate) fn trust_marker(&self) -> String {
        match self {
            TunnelKind::Proxy { url, .. } => format!("skopos-tunnel:proxy:{url}"),
            // The identity file stays out: a new key for the same host is the same tunnel.
            TunnelKind::Ssh {
                host,
                user,
                port,
                jump,
                ..
            } => format!(
                "skopos-tunnel:ssh:{}@{host}:{}:{}",
                user.as_deref().unwrap_or(""),
                port.map(|port| port.to_string()).unwrap_or_default(),
                jump.as_deref().unwrap_or(""),
            ),
        }
    }

    #[allow(dead_code)] // Used by a later task.
    pub(crate) fn is_ssh(&self) -> bool {
        matches!(self, TunnelKind::Ssh { .. })
    }

    /// The SSH fields, for the argument builder; `None` for a proxy tunnel.
    #[allow(dead_code)] // Used by a later task.
    pub(crate) fn ssh_fields(&self) -> Option<SshFields<'_>> {
        match self {
            TunnelKind::Ssh {
                host,
                user,
                port,
                jump,
                identity_file,
            } => Some(SshFields {
                host,
                user: user.as_deref(),
                port: *port,
                jump: jump.as_deref(),
                identity_file: identity_file.as_deref(),
            }),
            TunnelKind::Proxy { .. } => None,
        }
    }
}

/// One tunnel as `tunnels.json` keeps it. Never sent to the webview: see `TunnelView`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDef {
    pub id: String,
    pub name: String,
    pub kind: TunnelKind,
    /// The keychain accounts this tunnel wrote, never their values (spec §5.3).
    #[serde(default)]
    pub remembered: Vec<String>,
}

/// What the tunnel dialog sends: `id` is `None` for a new tunnel.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: TunnelKind,
}

/// `scheme://host[:port]` from a proxy URL with no user, path, query or fragment.
pub fn proxy_url(text: &str) -> CoreResult<String> {
    let parsed = Url::parse(text.trim()).map_err(|_| invalid(PROXY_URL_ERROR))?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5") {
        return Err(invalid(PROXY_URL_ERROR));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid(PROXY_USERINFO_ERROR));
    }
    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| invalid(PROXY_URL_ERROR))?;
    if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some()
    {
        return Err(invalid(PROXY_URL_ERROR));
    }
    let scheme = parsed.scheme();
    Ok(match parsed.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

/// A trimmed name of 1 to `NAME_MAX` characters without control characters.
pub fn tunnel_name(text: &str) -> CoreResult<String> {
    let name = text.trim();
    if name.is_empty() {
        return Err(invalid("A name is needed."));
    }
    if name.chars().count() > NAME_MAX {
        return Err(invalid(format!(
            "A name has at most {NAME_MAX} characters."
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(invalid("A name cannot hold control characters."));
    }
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(
        host: &str,
        user: Option<&str>,
        port: Option<u16>,
        jump: Option<&str>,
        identity_file: Option<&str>,
    ) -> TunnelKind {
        TunnelKind::Ssh {
            host: host.into(),
            user: user.map(Into::into),
            port,
            jump: jump.map(Into::into),
            identity_file: identity_file.map(Into::into),
        }
    }

    #[test]
    fn ssh_fields_are_trimmed_and_blank_ones_dropped() {
        let identity = std::env::temp_dir().join("id_ed25519");
        let identity = identity.to_str().unwrap();
        let kind = ssh(
            " bastion.corp ",
            Some(" me "),
            Some(2222),
            Some("  "),
            Some(identity),
        )
        .normalized()
        .unwrap();
        assert_eq!(
            kind,
            ssh("bastion.corp", Some("me"), Some(2222), None, Some(identity))
        );
        let bare = ssh("coder.ws", Some(""), None, None, Some(" "))
            .normalized()
            .unwrap();
        assert_eq!(bare, ssh("coder.ws", None, None, None, None));
    }

    #[test]
    fn ssh_fields_that_look_like_options_are_refused() {
        let host = "The host cannot start with \"-\" or hold spaces or control characters.";
        let user = "The user cannot start with \"-\" or hold spaces or control characters.";
        let jump = "The jump host cannot start with \"-\" or hold spaces or control characters.";
        for (kind, message) in [
            (ssh("-oProxyCommand=sh", None, None, None, None), host),
            (ssh("bastion corp", None, None, None, None), host),
            (ssh("bastion\u{7}", None, None, None, None), host),
            (ssh("   ", None, None, None, None), SSH_HOST_NEEDED),
            (ssh("bastion", Some("-lroot"), None, None, None), user),
            (ssh("bastion", None, None, Some("a\tb"), None), jump),
            (ssh("bastion", None, None, Some("-J"), None), jump),
            (ssh("bastion", None, Some(0), None, None), SSH_PORT_ERROR),
            (
                ssh("bastion", None, None, None, Some("keys/id")),
                SSH_IDENTITY_ERROR,
            ),
        ] {
            let refused = kind.clone().normalized().unwrap_err();
            assert_eq!(refused.code, ErrorCode::InvalidInput, "{kind:?}");
            assert_eq!(refused.message, message, "{kind:?}");
        }
    }

    #[test]
    fn the_ssh_trust_marker_names_user_host_port_and_jump_but_not_the_key() {
        let a = ssh("bastion", Some("me"), Some(22), Some("jump"), Some("/k1"));
        let b = ssh("bastion", Some("me"), Some(22), Some("jump"), Some("/k2"));
        assert_eq!(a.trust_marker(), "skopos-tunnel:ssh:me@bastion:22:jump");
        assert_eq!(a.trust_marker(), b.trust_marker());
        assert_eq!(
            ssh("bastion", None, None, None, None).trust_marker(),
            "skopos-tunnel:ssh:@bastion::"
        );
        assert!(a.is_ssh());
        assert_eq!(
            a.ssh_fields(),
            Some(SshFields {
                host: "bastion",
                user: Some("me"),
                port: Some(22),
                jump: Some("jump"),
                identity_file: Some("/k1"),
            })
        );
    }

    #[test]
    fn a_proxy_url_keeps_scheme_host_and_port() {
        assert_eq!(
            proxy_url(" http://proxy.corp:3128/ ").unwrap(),
            "http://proxy.corp:3128"
        );
        assert_eq!(
            proxy_url("socks5://10.0.0.5:1080").unwrap(),
            "socks5://10.0.0.5:1080"
        );
        assert_eq!(
            proxy_url("https://[::1]:8443").unwrap(),
            "https://[::1]:8443"
        );
        assert_eq!(proxy_url("http://proxy.corp").unwrap(), "http://proxy.corp");
    }

    #[test]
    fn a_proxy_url_with_userinfo_is_refused_without_quoting_it() {
        let err = proxy_url("http://me:hunter2@proxy.corp:3128").unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(err.message, PROXY_USERINFO_ERROR);
        assert!(!format!("{err:?}").contains("hunter2"));
    }

    #[test]
    fn other_schemes_paths_and_queries_are_refused() {
        for text in [
            "ftp://p:21",
            "socks5h://p:1080",
            "socks4://p:1080",
            "http://p:3128/x",
            "http://p:3128?a=b",
            "http://p#f",
            "not a url",
            "http://",
        ] {
            assert_eq!(
                proxy_url(text).unwrap_err().message,
                PROXY_URL_ERROR,
                "{text}"
            );
        }
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(tunnel_name("  corp  ").unwrap(), "corp");
        assert_eq!(tunnel_name(" ").unwrap_err().message, "A name is needed.");
        assert!(tunnel_name(&"x".repeat(NAME_MAX)).is_ok());
        assert!(tunnel_name(&"x".repeat(NAME_MAX + 1)).is_err());
        assert!(tunnel_name("a\u{7}b").is_err());
    }

    #[test]
    fn a_blank_username_is_none_and_a_colon_is_refused() {
        let kind = TunnelKind::Proxy {
            url: "http://p:1".into(),
            username: Some("  ".into()),
        };
        assert_eq!(
            kind.normalized().unwrap(),
            TunnelKind::Proxy {
                url: "http://p:1".into(),
                username: None
            }
        );
        let colon = TunnelKind::Proxy {
            url: "http://p:1".into(),
            username: Some("a:b".into()),
        };
        assert!(colon.normalized().is_err());
    }
}
