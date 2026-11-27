//! The local CONNECT gateway every consumer of a tunnel goes through (tunnels spec §5.5). It
//! never ends TLS and never reads what passes through.

use std::net::Ipv4Addr;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use tokio::io::{copy_bidirectional, AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use super::http::{authority, read_head, status_reason};
use super::runtime::OpenGuard;
use super::ssh::Origin;
use super::upstream::{DialError, Stream};
use crate::app_core::{AppCore, WeakCore};

const HEAD_CAP: usize = 8 * 1024;
const HEAD_LIMIT: Duration = Duration::from_secs(10);
pub(crate) const BAD_REQUEST: &str = "400 Bad Request";
pub(crate) const FORBIDDEN: &str = "403 Forbidden";
pub(crate) const METHOD_NOT_ALLOWED: &str = "405 Method Not Allowed";
pub(crate) const AUTH_REQUIRED: &str = "407 Proxy Authentication Required";

/// A `CONNECT` request head.
#[derive(PartialEq, Eq)]
pub(crate) struct ConnectRequest {
    /// Lowercase, an IPv6 address without brackets.
    pub(crate) host: String,
    pub(crate) port: u16,
    /// The Basic user name and password: a tunnel id and its token.
    pub(crate) credentials: Option<(String, String)>,
}

impl std::fmt::Debug for ConnectRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectRequest")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.credentials.as_ref().map(|c| &c.0))
            .finish()
    }
}

/// Reads the request line and `Proxy-Authorization`. `Err` is the status to answer.
pub(crate) fn parse_connect(head: &str) -> Result<ConnectRequest, &'static str> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (first.next(), first.next(), first.next(), first.next())
    else {
        return Err(BAD_REQUEST);
    };
    if !version.starts_with("HTTP/1.") {
        return Err(BAD_REQUEST);
    }
    if method != "CONNECT" {
        return Err(METHOD_NOT_ALLOWED);
    }
    let (host, port) = split_target(target).ok_or(BAD_REQUEST)?;
    let credentials = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("proxy-authorization"))
        .and_then(|(_, value)| basic_credentials(value.trim()));
    Ok(ConnectRequest {
        host,
        port,
        credentials,
    })
}

fn split_target(target: &str) -> Option<(String, u16)> {
    let (host, port) = match target.strip_prefix('[') {
        Some(rest) => {
            let (host, after) = rest.split_once(']')?;
            (host, after.strip_prefix(':')?)
        }
        None => {
            let (host, port) = target.rsplit_once(':')?;
            if host.contains(':') {
                return None;
            }
            (host, port)
        }
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_ascii_lowercase(), port.parse().ok()?))
}

fn basic_credentials(value: &str) -> Option<(String, String)> {
    let (scheme, encoded) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = String::from_utf8(STANDARD.decode(encoded.trim()).ok()?).ok()?;
    let (user, password) = decoded.split_once(':')?;
    Some((user.to_owned(), password.to_owned()))
}

/// Binds `127.0.0.1:0` and serves on `runtime` until `shutdown` fires. Returns the port.
pub(crate) fn start(
    core: WeakCore,
    runtime: &Handle,
    shutdown: CancellationToken,
) -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let listener = {
        let _entered = runtime.enter();
        TcpListener::from_std(listener)?
    };
    runtime.spawn(async move {
        loop {
            let accepted = tokio::select! {
                () = shutdown.cancelled() => return,
                accepted = listener.accept() => accepted,
            };
            match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(serve(core.clone(), stream));
                }
                Err(e) => {
                    tracing::warn!("the tunnel gateway cannot accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });
    Ok(port)
}

/// A CONNECT the gateway took: the stream to the target, and what ends it.
pub(crate) struct Admitted {
    upstream: Box<dyn Stream>,
    cancel: CancellationToken,
    _open: OpenGuard,
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin>(core: WeakCore, mut client: S) {
    let head = match tokio::time::timeout(HEAD_LIMIT, read_head(&mut client, HEAD_CAP)).await {
        Ok(Ok(head)) => head,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::InvalidData => {
            let _ = reply(&mut client, BAD_REQUEST).await;
            return;
        }
        _ => return,
    };
    let request = match parse_connect(&head) {
        Ok(request) => request,
        Err(status) => {
            let _ = reply(&mut client, status).await;
            return;
        }
    };
    let Some(app) = core.upgrade() else { return };
    let admitted = app.tunnel_admit(&request).await;
    drop(app);
    match admitted {
        Err(status) => {
            let _ = reply(&mut client, &status).await;
        }
        Ok(mut admitted) => {
            if reply(&mut client, "200 Connection established")
                .await
                .is_err()
            {
                return;
            }
            tokio::select! {
                () = admitted.cancel.cancelled() => {}
                _ = copy_bidirectional(&mut client, &mut admitted.upstream) => {}
            }
        }
    }
}

async fn reply<S: AsyncWrite + Unpin>(client: &mut S, status: &str) -> std::io::Result<()> {
    let mut text = format!("HTTP/1.1 {status}\r\n");
    if !status.starts_with("200") {
        if status == AUTH_REQUIRED {
            text.push_str("Proxy-Authenticate: Basic realm=\"SkoposIDE\"\r\n");
        }
        text.push_str("Content-Length: 0\r\nConnection: close\r\n");
    }
    text.push_str("\r\n");
    client.write_all(text.as_bytes()).await?;
    client.flush().await
}

impl AppCore {
    /// Checks a CONNECT and dials its target (spec §5.5). `Err` is the status to answer.
    pub(crate) async fn tunnel_admit(&self, request: &ConnectRequest) -> Result<Admitted, String> {
        let Some((id, token)) = &request.credentials else {
            return Err(AUTH_REQUIRED.to_owned());
        };
        if !self.tunnel_token_matches(id, token) {
            return Err(AUTH_REQUIRED.to_owned());
        }
        let Some(def) = self.tunnel_def(id) else {
            return Err(AUTH_REQUIRED.to_owned());
        };
        let target = authority(&request.host, request.port);
        if !self
            .tunnel_targets(id)
            .contains(&(request.host.clone(), request.port))
        {
            tracing::info!("tunnel {}: refused {target}", def.name);
            return Err(FORBIDDEN.to_owned());
        }
        let cancel = self.tunnel_runtime().cancel_token(id);
        let open = self.tunnel_runtime().open_guard(id);
        match self
            .tunnel_dial(&def, &request.host, request.port, Origin::Gateway)
            .await
        {
            Ok(upstream) => {
                tracing::debug!("tunnel {}: opened {target}", def.name);
                Ok(Admitted {
                    upstream,
                    cancel,
                    _open: open,
                })
            }
            Err(DialError::TimedOut) => {
                tracing::info!("tunnel {}: {target} timed out", def.name);
                Err(format!(
                    "504 {}",
                    status_reason(&format!("Tunnel \"{}\" timed out", def.name))
                ))
            }
            Err(DialError::Reconnecting(_)) => {
                tracing::info!("tunnel {}: {target} waits for a reconnect", def.name);
                Err(format!(
                    "503 {}",
                    status_reason(&format!("Tunnel \"{}\" is reconnecting", def.name))
                ))
            }
            Err(e) => {
                tracing::info!("tunnel {}: {target} failed", def.name);
                Err(format!(
                    "502 {}",
                    status_reason(&format!("Tunnel \"{}\": {}", def.name, e.reason()))
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn basic(user: &str, password: &str) -> String {
        STANDARD.encode(format!("{user}:{password}"))
    }

    #[test]
    fn parse_connect_reads_host_port_and_basic() {
        let head = format!(
            "CONNECT API.Internal:6443 HTTP/1.1\r\nHost: api.internal:6443\r\n\
             proxy-authorization: Basic {}\r\n\r\n",
            basic("t1", "tok")
        );
        let request = parse_connect(&head).unwrap();
        assert_eq!(request.host, "api.internal");
        assert_eq!(request.port, 6443);
        assert_eq!(
            request.credentials,
            Some(("t1".to_owned(), "tok".to_owned()))
        );
        assert!(!format!("{request:?}").contains("tok\""), "{request:?}");
    }

    #[test]
    fn parse_connect_reads_ipv6_targets() {
        let request = parse_connect("CONNECT [::1]:443 HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!((request.host.as_str(), request.port), ("::1", 443));
        assert_eq!(request.credentials, None);
    }

    #[test]
    fn other_methods_get_405_and_bad_targets_400() {
        assert_eq!(
            parse_connect("GET / HTTP/1.1\r\n\r\n").unwrap_err(),
            METHOD_NOT_ALLOWED
        );
        for head in [
            "CONNECT nohost HTTP/1.1\r\n\r\n",
            "CONNECT ::1:443 HTTP/1.1\r\n\r\n",
            "CONNECT host:99999 HTTP/1.1\r\n\r\n",
            "CONNECT host:1\r\n\r\n",
        ] {
            assert_eq!(parse_connect(head).unwrap_err(), BAD_REQUEST, "{head}");
        }
    }

    #[tokio::test]
    async fn the_gateway_answers_405_and_closes() {
        let (mut client, server) = tokio::io::duplex(4096);
        tokio::spawn(serve(WeakCore::none(), server));
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut answer = String::new();
        client.read_to_string(&mut answer).await.unwrap();
        assert!(
            answer.starts_with("HTTP/1.1 405 Method Not Allowed\r\n"),
            "{answer}"
        );
    }

    #[tokio::test]
    async fn a_head_over_8_kib_gets_400() {
        let (client, server) = tokio::io::duplex(1024);
        tokio::spawn(serve(WeakCore::none(), server));
        let (mut read, mut write) = tokio::io::split(client);
        tokio::spawn(async move {
            let _ = write.write_all(&[b'a'; 9000]).await;
        });
        let mut answer = String::new();
        read.read_to_string(&mut answer).await.unwrap();
        assert!(
            answer.starts_with("HTTP/1.1 400 Bad Request\r\n"),
            "{answer}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_head_that_does_not_end_within_10_s_is_closed() {
        let (mut client, server) = tokio::io::duplex(4096);
        let started = tokio::time::Instant::now();
        tokio::spawn(serve(WeakCore::none(), server));
        client.write_all(b"CONNECT a:1 HTTP/1.1\r\n").await.unwrap();
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(20), client.read_to_end(&mut rest))
            .await
            .expect("the gateway closes the connection")
            .unwrap();
        assert!(rest.is_empty());
        assert!(started.elapsed() >= HEAD_LIMIT);
    }
}
