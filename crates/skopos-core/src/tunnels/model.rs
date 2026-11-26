//! The tunnel definitions kept in `tunnels.json` (tunnels spec §5.2) and their checks.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use url::Url;

use crate::error::{CoreResult, ErrorCode, IpcError};

/// The longest tunnel name, in characters.
pub const NAME_MAX: usize = 64;
pub const PROXY_URL_ERROR: &str =
    "Use http://, https:// or socks5:// with a host and an optional port";
pub const PROXY_USERINFO_ERROR: &str = "Put the user name and password in their own fields";

pub(crate) fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

/// How a tunnel reaches the private network. Phase 2 adds `Ssh`.
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
