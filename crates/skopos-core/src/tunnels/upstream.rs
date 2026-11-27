//! Dialing a target through a proxy tunnel (tunnels spec §5.6): a CONNECT client of its own for
//! http and https, so the proxy's status line reaches the person, and `hyper-util`'s `SocksV5`
//! for socks5, which sends host names to the proxy.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hyper_util::client::legacy::connect::proxy::SocksV5;
use hyper_util::client::legacy::connect::HttpConnector;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tower_service::Service;
use url::Url;

use super::http::{authority, read_head};
use crate::secrets::Secret;

/// How long reaching the target through the proxy may take (spec §5.6).
pub(crate) const DIAL_LIMIT: Duration = Duration::from_secs(15);
const HEAD_CAP: usize = 8 * 1024;

pub(crate) trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DialError {
    Failed(String),
    TimedOut,
    /// An SSH tunnel whose `ssh` is reconnecting; the last error (spec §6.4).
    Reconnecting(String),
}

impl DialError {
    pub(crate) fn reason(&self) -> String {
        match self {
            DialError::Failed(reason) => reason.clone(),
            DialError::TimedOut => format!("no answer within {} s", DIAL_LIMIT.as_secs()),
            DialError::Reconnecting(last) => format!("ssh is reconnecting ({last})"),
        }
    }
}

fn failed(reason: impl Into<String>) -> DialError {
    DialError::Failed(reason.into())
}

/// Where a proxy tunnel's proxy is and how to sign in to it.
pub(crate) struct ProxyUpstream {
    scheme: String,
    host: String,
    port: u16,
    credentials: Option<(String, Secret)>,
}

impl ProxyUpstream {
    /// `url` is a proxy URL as `model::proxy_url` returns it.
    pub(crate) fn new(url: &str, credentials: Option<(String, Secret)>) -> Result<Self, DialError> {
        let parsed = Url::parse(url).map_err(|_| failed("the proxy URL is not valid"))?;
        let scheme = parsed.scheme().to_owned();
        let default_port = match scheme.as_str() {
            "http" => 80,
            "https" => 443,
            "socks5" => 1080,
            other => return Err(failed(format!("the proxy scheme {other} is not supported"))),
        };
        let host = parsed
            .host_str()
            .ok_or_else(|| failed("the proxy URL has no host"))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        Ok(Self {
            scheme,
            host,
            port: parsed.port().unwrap_or(default_port),
            credentials,
        })
    }

    /// A connection to `host:port` through the proxy, within `DIAL_LIMIT`.
    pub(crate) async fn dial(&self, host: &str, port: u16) -> Result<Box<dyn Stream>, DialError> {
        tokio::time::timeout(DIAL_LIMIT, self.dial_now(host, port))
            .await
            .unwrap_or(Err(DialError::TimedOut))
    }

    async fn dial_now(&self, host: &str, port: u16) -> Result<Box<dyn Stream>, DialError> {
        if self.scheme == "socks5" {
            return self.socks5(host, port).await;
        }
        let stream = self.open().await?;
        Ok(Box::new(
            connect_through(stream, host, port, self.credentials.as_ref()).await?,
        ))
    }

    /// Reaches the proxy without asking it for a target: `Test connection` of a tunnel no
    /// cluster uses yet. TCP, and the TLS handshake for an `https` proxy.
    pub(crate) async fn reach_proxy(&self) -> Result<(), DialError> {
        let reach = async {
            if self.scheme == "socks5" {
                self.reach().await.map(drop)
            } else {
                self.open().await.map(drop)
            }
        };
        tokio::time::timeout(DIAL_LIMIT, reach)
            .await
            .unwrap_or(Err(DialError::TimedOut))
    }

    /// A connection to the proxy itself: TCP, then TLS for an `https` proxy.
    async fn open(&self) -> Result<Box<dyn Stream>, DialError> {
        let tcp = self.reach().await?;
        if self.scheme != "https" {
            return Ok(Box::new(tcp));
        }
        let name = rustls::pki_types::ServerName::try_from(self.host.clone())
            .map_err(|_| failed("the proxy's host name is not valid"))?;
        let tls = TlsConnector::from(platform_tls()?)
            .connect(name, tcp)
            .await
            .map_err(|e| failed(format!("TLS with the proxy failed: {e}")))?;
        Ok(Box::new(tls))
    }

    async fn reach(&self) -> Result<TcpStream, DialError> {
        TcpStream::connect((self.host.as_str(), self.port))
            .await
            .map_err(|e| {
                failed(format!(
                    "cannot reach the proxy at {}: {e}",
                    authority(&self.host, self.port)
                ))
            })
    }

    async fn socks5(&self, host: &str, port: u16) -> Result<Box<dyn Stream>, DialError> {
        let mut connector = HttpConnector::new();
        connector.enforce_http(false);
        let proxy: http::Uri = format!("http://{}", authority(&self.host, self.port))
            .parse()
            .map_err(|_| failed("the proxy URL is not valid"))?;
        let mut socks = SocksV5::new(proxy, connector);
        if let Some((user, password)) = &self.credentials {
            socks = socks.with_auth(user.clone(), password.expose().to_owned());
        }
        let target: http::Uri = format!("http://{}", authority(host, port))
            .parse()
            .map_err(|_| failed(format!("{host} is not a valid host name")))?;
        std::future::poll_fn(|cx| socks.poll_ready(cx))
            .await
            .map_err(|e| failed(format!("cannot reach the SOCKS5 proxy: {e}")))?;
        let io = socks.call(target).await.map_err(|e| {
            failed(format!(
                "the SOCKS5 proxy at {} refused: {e}",
                authority(&self.host, self.port)
            ))
        })?;
        Ok(Box::new(io.into_inner()))
    }
}

/// Sends `CONNECT` and reads the answer; on 2xx the stream is the tunnel.
async fn connect_through<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    host: &str,
    port: u16,
    credentials: Option<&(String, Secret)>,
) -> Result<S, DialError> {
    let target = authority(host, port);
    let mut head = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some((user, password)) = credentials {
        head.push_str("Proxy-Authorization: Basic ");
        head.push_str(&STANDARD.encode(format!("{user}:{}", password.expose())));
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| failed(format!("cannot talk to the proxy: {e}")))?;
    let answer = read_head(&mut stream, HEAD_CAP)
        .await
        .map_err(|e| failed(format!("the proxy did not answer: {e}")))?;
    let status = answer.lines().next().unwrap_or_default().trim();
    let reason: String = status
        .split_once(' ')
        .map_or(status, |(_, rest)| rest)
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    match status
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
    {
        Some(200..=299) => Ok(stream),
        Some(407) => Err(failed(format!(
            "the proxy refused the user name or password ({reason})"
        ))),
        Some(_) => Err(failed(format!("the proxy answered {reason}"))),
        None => Err(failed("the proxy did not answer in HTTP")),
    }
}

/// The system's roots, as `reqwest` checks them.
fn platform_tls() -> Result<Arc<rustls::ClientConfig>, DialError> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .and_then(|builder| builder.with_platform_verifier())
        .map_err(|e| failed(format!("TLS setup failed: {e}")))?
        .with_no_client_auth();
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use skopos_fakekube::proxy::{echo_server, http_proxy, socks5_proxy, ProxyOptions};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn ping(stream: &mut Box<dyn Stream>) -> Vec<u8> {
        stream.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.unwrap();
        buf.to_vec()
    }

    fn creds(user: &str, password: &str) -> Option<(String, Secret)> {
        Some((user.to_owned(), Secret::new(password)))
    }

    fn with_creds(user: &str, password: &str) -> ProxyOptions {
        ProxyOptions {
            credentials: Some((user.into(), password.into())),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn an_http_proxy_with_a_password_reaches_the_target() {
        let echo = echo_server().await;
        let proxy = http_proxy(with_creds("me", "pw")).await;
        let upstream =
            ProxyUpstream::new(&format!("http://{}", proxy.addr), creds("me", "pw")).unwrap();
        let mut stream = upstream.dial("127.0.0.1", echo.addr.port()).await.unwrap();
        assert_eq!(ping(&mut stream).await, b"ping");
        assert_eq!(
            proxy.seen.targets(),
            [format!("127.0.0.1:{}", echo.addr.port())]
        );
    }

    #[tokio::test]
    async fn a_wrong_proxy_password_says_so_without_the_password() {
        let proxy = http_proxy(with_creds("me", "pw")).await;
        let upstream =
            ProxyUpstream::new(&format!("http://{}", proxy.addr), creds("me", "hunter2")).unwrap();
        let err = upstream.dial("127.0.0.1", 1).await.err().unwrap();
        let reason = err.reason();
        assert!(
            reason.contains("refused the user name or password"),
            "{reason}"
        );
        assert!(!reason.contains("hunter2"), "{reason}");
    }

    #[tokio::test]
    async fn the_proxy_status_line_is_the_reason() {
        let proxy = http_proxy(ProxyOptions {
            refuse_with: Some("403 Forbidden by policy".into()),
            ..Default::default()
        })
        .await;
        let upstream = ProxyUpstream::new(&format!("http://{}", proxy.addr), None).unwrap();
        let err = upstream.dial("api.internal", 443).await.err().unwrap();
        assert_eq!(err.reason(), "the proxy answered 403 Forbidden by policy");
    }

    #[tokio::test]
    async fn socks5_with_a_password_sends_host_names_to_the_proxy() {
        let echo = echo_server().await;
        let mut options = with_creds("me", "pw");
        options.hosts.insert("api.internal".into(), echo.addr);
        let proxy = socks5_proxy(options).await;
        let upstream =
            ProxyUpstream::new(&format!("socks5://{}", proxy.addr), creds("me", "pw")).unwrap();
        let mut stream = upstream.dial("api.internal", 6443).await.unwrap();
        assert_eq!(ping(&mut stream).await, b"ping");
        assert_eq!(proxy.seen.targets(), ["api.internal:6443"]);
    }

    #[tokio::test]
    async fn a_wrong_socks5_password_fails() {
        let proxy = socks5_proxy(with_creds("me", "pw")).await;
        let upstream =
            ProxyUpstream::new(&format!("socks5://{}", proxy.addr), creds("me", "nope")).unwrap();
        assert!(upstream.dial("127.0.0.1", 1).await.is_err());
    }

    #[tokio::test]
    async fn an_unreachable_proxy_names_its_address() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let upstream = ProxyUpstream::new(&format!("http://127.0.0.1:{port}"), None).unwrap();
        let reason = upstream.dial("x", 1).await.err().unwrap().reason();
        assert!(reason.contains(&format!("127.0.0.1:{port}")), "{reason}");
    }

    #[tokio::test]
    async fn reach_proxy_needs_only_the_proxy() {
        let proxy = http_proxy(with_creds("me", "pw")).await;
        let upstream = ProxyUpstream::new(&format!("http://{}", proxy.addr), None).unwrap();
        assert_eq!(upstream.reach_proxy().await, Ok(()));
        assert!(proxy.seen.targets().is_empty());
        let gone = ProxyUpstream::new("socks5://127.0.0.1:1", None).unwrap();
        assert!(gone.reach_proxy().await.is_err());
    }

    #[test]
    fn the_platform_verifier_builds() {
        assert!(platform_tls().is_ok());
    }
}
