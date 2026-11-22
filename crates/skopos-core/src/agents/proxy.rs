//! The per-chat network proxy (spec §4.7, §6.6, §6.7). The agent's `HTTPS_PROXY` names it
//! with the chat's token. It tunnels only `CONNECT <host>:443` to a host on the chat's
//! allowlist whose every address is neither loopback, link-local nor unspecified, so an
//! allowed name cannot lead to the person's port-forwards or a cloud metadata service. It
//! connects to the addresses it checked and never looks the name up again. Everything else
//! is refused, and the first refusal of each host goes out on `blocked` for the chat's
//! notice (`The sandbox blocked <host>.`).

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::endpoint::{same_bytes, AsyncStream, Endpoint};

/// The most a request head may take, its blank line included.
pub const HEAD_CAP: usize = 16 * 1024;
/// How long a client may take to send its request head.
const HEAD_WAIT: Duration = Duration::from_secs(10);
/// How long connecting to one address of an allowed host may take.
const CONNECT_WAIT: Duration = Duration::from_secs(10);
/// The only port a tunnel goes to.
const HTTPS_PORT: u16 = 443;
/// The user name of the proxy URL, `http://skopos:<token>@127.0.0.1:<port>`.
const PROXY_USER: &str = "skopos";
/// The longest host name DNS allows.
const HOST_CAP: usize = 253;
/// How long the accept loop waits after a failed accept, so it does not spin.
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);
const ESTABLISHED: &[u8] = b"HTTP/1.1 200 Connection established\r\n\r\n";

/// How the proxy finds a host's addresses.
#[derive(Debug, Clone)]
pub enum Resolver {
    /// The system's resolver.
    System,
    /// Fixed answers, for tests. A host the map does not hold does not resolve.
    Fixed(HashMap<String, Vec<IpAddr>>),
}

/// One chat's proxy. No `Debug`, so the token cannot reach a log line.
#[derive(Clone)]
pub struct ProxyConfig {
    /// The chat's token, the password of the proxy URL.
    pub token: String,
    /// The chat agent's provider hosts and the person's domains.
    pub hosts: Vec<String>,
    pub resolve: Resolver,
}

/// Whether `host` is an allowed entry or a subdomain of one, ignoring case. An IP literal
/// never is, whatever the list holds.
pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    if host.is_empty() || is_ip_literal(&host) {
        return false;
    }
    allowed.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        !entry.is_empty()
            && (host == entry
                || host
                    .strip_suffix(entry.as_str())
                    .is_some_and(|sub| sub.len() > 1 && sub.ends_with('.')))
    })
}

/// Whether the proxy may connect to `ip`: not loopback, link-local or unspecified
/// (`0.0.0.0/8` included, since `0.0.0.0` reaches the machine's own listeners), in either
/// family, with the IPv4-mapped and IPv4-compatible forms of those refused too.
pub fn address_allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_allowed(v4),
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_unicast_link_local() {
                return false;
            }
            v6.to_ipv4().is_none_or(v4_allowed)
        }
    }
}

fn v4_allowed(v4: Ipv4Addr) -> bool {
    !(v4.is_loopback() || v4.is_link_local() || v4.octets()[0] == 0)
}

/// An IP address, bracketed or not, or a name whose last label is a number: the resolver
/// reads `127.1`, `2130706433` and `0x7f.1` as IPv4 addresses.
fn is_ip_literal(host: &str) -> bool {
    let bare = host
        .strip_prefix('[')
        .and_then(|inside| inside.strip_suffix(']'))
        .unwrap_or(host);
    let last_label = host
        .trim_end_matches('.')
        .rsplit('.')
        .next()
        .unwrap_or_default();
    bare.parse::<IpAddr>().is_ok() || numeric_label(last_label)
}

fn numeric_label(label: &str) -> bool {
    match label.strip_prefix("0x") {
        Some(hex) => !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()),
        None => !label.is_empty() && label.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// What the proxy answers instead of a tunnel. Each answer closes the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    BadRequest,
    Unauthorized,
    Forbidden,
    TooLarge,
    BadGateway,
}

impl Refusal {
    fn response(self) -> &'static [u8] {
        match self {
            Refusal::BadRequest => {
                b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            }
            Refusal::Unauthorized => b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"skopos\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            Refusal::Forbidden => {
                b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            }
            Refusal::TooLarge => b"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            Refusal::BadGateway => {
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            }
        }
    }
}

/// A request head as far as the proxy reads it.
#[derive(Debug, PartialEq, Eq)]
struct Head {
    method: String,
    target: String,
    /// The `Host` header, which names a plain request's host in origin form.
    host_header: Option<String>,
    authorization: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum HeadError {
    /// The client closed, or the stream failed, before the head ended.
    Closed,
    TooLarge,
    Malformed,
}

/// Reads up to the blank line that ends the head, at most `HEAD_CAP` bytes. Gives the head
/// and the bytes read past it, which belong to the tunnel.
async fn read_head<S: AsyncRead + Unpin + ?Sized>(
    stream: &mut S,
) -> Result<(Head, Vec<u8>), HeadError> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let end = loop {
        let searched_from = buf.len().saturating_sub(3);
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|_| HeadError::Closed)?;
        if n == 0 {
            return Err(HeadError::Closed);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf[searched_from..]
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            break searched_from + at;
        }
        if buf.len() > HEAD_CAP {
            return Err(HeadError::TooLarge);
        }
    };
    if end + 4 > HEAD_CAP {
        return Err(HeadError::TooLarge);
    }
    let rest = buf.split_off(end + 4);
    let head = parse_head(&buf[..end]).ok_or(HeadError::Malformed)?;
    Ok((head, rest))
}

/// The request line and the two headers the proxy needs, from a head without its blank
/// line. `None` for anything an HTTP/1 client would not send, a repeated
/// `Proxy-Authorization` or `Host` included.
fn parse_head(bytes: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split(' ');
    let (method, target, version) = (request.next()?, request.next()?, request.next()?);
    if request.next().is_some()
        || method.is_empty()
        || target.is_empty()
        || !version.starts_with("HTTP/1.")
    {
        return None;
    }
    let mut head = Head {
        method: method.to_owned(),
        target: target.to_owned(),
        host_header: None,
        authorization: None,
    };
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.is_empty() || name.contains(|c: char| c.is_ascii_whitespace()) {
            return None;
        }
        let value = value.trim().to_owned();
        let repeated = if name.eq_ignore_ascii_case("proxy-authorization") {
            head.authorization.replace(value).is_some()
        } else if name.eq_ignore_ascii_case("host") {
            head.host_header.replace(value).is_some()
        } else {
            false
        };
        if repeated {
            return None;
        }
    }
    Some(head)
}

/// Whether `header` is `Basic base64("skopos:<token>")`.
fn authorized(header: Option<&str>, token: &str) -> bool {
    let Some((scheme, credentials)) = header.and_then(|header| header.split_once(' ')) else {
        return false;
    };
    if token.is_empty() || !scheme.eq_ignore_ascii_case("basic") {
        return false;
    }
    let Ok(decoded) = STANDARD.decode(credentials.trim()) else {
        return false;
    };
    same_bytes(&decoded, format!("{PROXY_USER}:{token}").as_bytes())
}

/// Splits `host[:port]` or `[address][:port]` into the lower-cased host and the port,
/// which is `None` when missing or not a number. `None` when the host is empty, too long,
/// or holds a character that no host name or IP literal has.
fn split_authority(authority: &str) -> Option<(String, Option<u16>)> {
    let (host, port) = match authority.strip_prefix('[') {
        Some(inside) => {
            let (address, after) = inside.split_once(']')?;
            (&authority[..address.len() + 2], after.strip_prefix(':'))
        }
        None => match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    let host = host.to_ascii_lowercase();
    let readable = !host.is_empty()
        && host.len() <= HOST_CAP
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_:[]".contains(&b));
    if !readable {
        return None;
    }
    Some((host, port.and_then(|port| port.parse().ok())))
}

/// The host a plain HTTP request is for: from an absolute URL, else from `Host`.
fn plain_http_host(head: &Head) -> Option<String> {
    let authority = match head.target.split_once("://") {
        Some((_scheme, rest)) => rest.split(['/', '?', '#']).next().unwrap_or(rest),
        None => head.host_header.as_deref()?,
    };
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_userinfo, host)| host);
    split_authority(authority).map(|(host, _port)| host)
}

/// What the proxy does with a request, before any lookup.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// `407`: no token, or another one.
    Unauthorized,
    /// `400`: no host to go to.
    BadRequest,
    /// `403`, and the host is reported.
    Blocked(String),
    /// Resolve the host and tunnel to it.
    Tunnel(String),
}

fn judge(head: &Head, config: &ProxyConfig) -> Verdict {
    if !authorized(head.authorization.as_deref(), &config.token) {
        return Verdict::Unauthorized;
    }
    if head.method != "CONNECT" {
        return match plain_http_host(head) {
            Some(host) => Verdict::Blocked(host),
            None => Verdict::BadRequest,
        };
    }
    match split_authority(&head.target) {
        None => Verdict::BadRequest,
        Some((host, Some(HTTPS_PORT))) if host_allowed(&host, &config.hosts) => {
            Verdict::Tunnel(host)
        }
        Some((host, _port)) => Verdict::Blocked(host),
    }
}

/// The host's addresses; empty when it does not resolve.
async fn resolve(resolver: &Resolver, host: &str) -> Vec<IpAddr> {
    match resolver {
        Resolver::Fixed(answers) => answers.get(host).cloned().unwrap_or_default(),
        Resolver::System => match tokio::net::lookup_host((host, HTTPS_PORT)).await {
            Ok(found) => found.map(|address| address.ip()).collect(),
            Err(_) => Vec::new(),
        },
    }
}

/// Connects to the first of `addresses` that answers on `port`.
async fn connect(addresses: &[IpAddr], port: u16) -> Option<TcpStream> {
    for ip in addresses {
        let attempt = TcpStream::connect(SocketAddr::new(*ip, port));
        if let Ok(Ok(stream)) = tokio::time::timeout(CONNECT_WAIT, attempt).await {
            return Some(stream);
        }
    }
    None
}

/// What one proxy's connections share.
struct Shared {
    config: ProxyConfig,
    blocked: mpsc::Sender<String>,
    reported: Mutex<HashSet<String>>,
    upstream_port: u16,
}

impl Shared {
    fn new(config: ProxyConfig, blocked: mpsc::Sender<String>, upstream_port: u16) -> Arc<Shared> {
        Arc::new(Shared {
            config,
            blocked,
            reported: Mutex::new(HashSet::new()),
            upstream_port,
        })
    }

    /// Sends `host` on `blocked` the first time this proxy refuses it.
    async fn report(&self, host: String) {
        let first = self
            .reported
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(host.clone());
        if first {
            // A chat that has gone needs no notice.
            let _ = self.blocked.send(host).await;
        }
    }
}

/// Answers with `refusal` and closes. A client that has gone gets nothing.
async fn answer<S: AsyncWrite + Unpin + ?Sized>(client: &mut S, refusal: Refusal) {
    let _ = client.write_all(refusal.response()).await;
    let _ = client.shutdown().await;
}

/// Reports `host` (the first time) and answers `403`. The report goes first, so a client
/// that has its answer knows the report was made.
async fn refuse<S: AsyncWrite + Unpin + ?Sized>(client: &mut S, shared: &Shared, host: String) {
    shared.report(host).await;
    answer(client, Refusal::Forbidden).await;
}

/// Serves one connection: one request head, then a refusal or a tunnel.
async fn handle(mut client: Box<dyn AsyncStream>, shared: Arc<Shared>) {
    let read = tokio::time::timeout(HEAD_WAIT, read_head(&mut client)).await;
    let (head, early) = match read {
        Ok(Ok(read)) => read,
        Ok(Err(HeadError::TooLarge)) => return answer(&mut client, Refusal::TooLarge).await,
        Ok(Err(HeadError::Malformed)) => return answer(&mut client, Refusal::BadRequest).await,
        Ok(Err(HeadError::Closed)) | Err(_) => return,
    };
    let host = match judge(&head, &shared.config) {
        Verdict::Tunnel(host) => host,
        Verdict::Blocked(host) => return refuse(&mut client, &shared, host).await,
        Verdict::Unauthorized => return answer(&mut client, Refusal::Unauthorized).await,
        Verdict::BadRequest => return answer(&mut client, Refusal::BadRequest).await,
    };
    let addresses = resolve(&shared.config.resolve, &host).await;
    if addresses.is_empty() {
        return answer(&mut client, Refusal::BadGateway).await;
    }
    if !addresses.iter().all(|ip| address_allowed(*ip)) {
        return refuse(&mut client, &shared, host).await;
    }
    let Some(mut upstream) = connect(&addresses, shared.upstream_port).await else {
        return answer(&mut client, Refusal::BadGateway).await;
    };
    if client.write_all(ESTABLISHED).await.is_err() || upstream.write_all(&early).await.is_err() {
        return;
    }
    // Either side closing ends the tunnel, however it closes.
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

/// Serves the chat's proxy on `endpoint` until `cancel` fires. Open tunnels end with it, and
/// dropping the endpoint removes its Unix socket file (spec §6.7).
pub async fn serve(
    endpoint: Endpoint,
    config: ProxyConfig,
    blocked: mpsc::Sender<String>,
    cancel: CancellationToken,
) {
    serve_to(endpoint, config, blocked, cancel, HTTPS_PORT).await;
}

/// `serve` for tests: an allowed tunnel goes to `upstream_port` of the host's addresses
/// instead of 443, so a test server on an unprivileged port can stand in for the host. The
/// client must still ask for port 443.
pub async fn serve_for_test(
    endpoint: Endpoint,
    config: ProxyConfig,
    blocked: mpsc::Sender<String>,
    cancel: CancellationToken,
    upstream_port: u16,
) {
    serve_to(endpoint, config, blocked, cancel, upstream_port).await;
}

async fn serve_to(
    endpoint: Endpoint,
    config: ProxyConfig,
    blocked: mpsc::Sender<String>,
    cancel: CancellationToken,
    upstream_port: u16,
) {
    let shared = Shared::new(config, blocked, upstream_port);
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            () = cancel.cancelled() => break,
            Some(_) = connections.join_next() => {}
            accepted = endpoint.accept() => match accepted {
                Ok(client) => {
                    connections.spawn(handle(client, Arc::clone(&shared)));
                }
                Err(error) => {
                    tracing::debug!("the agent proxy could not accept a connection: {error}");
                    tokio::time::sleep(ACCEPT_PAUSE).await;
                }
            },
        }
    }
    // Dropping the set aborts the open tunnels.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| (*entry).to_owned()).collect()
    }

    fn config() -> ProxyConfig {
        ProxyConfig {
            token: "t0k".to_owned(),
            hosts: list(&["api.example.com"]),
            resolve: Resolver::Fixed(HashMap::new()),
        }
    }

    /// A `Proxy-Authorization` header line with these credentials.
    fn basic(credentials: &str) -> String {
        format!(
            "Proxy-Authorization: Basic {}",
            STANDARD.encode(credentials)
        )
    }

    fn head(text: &str) -> Head {
        parse_head(text.as_bytes()).expect("a readable head")
    }

    /// A whole head, blank line included, of exactly `len` bytes.
    fn padded_head(len: usize) -> String {
        let start = "CONNECT api.example.com:443 HTTP/1.1\r\nX-Pad: ";
        let end = "\r\n\r\n";
        format!("{start}{}{end}", "a".repeat(len - start.len() - end.len()))
    }

    #[test]
    fn a_host_matches_itself_and_its_subdomains_ignoring_case() {
        let allowed = list(&["api.anthropic.com", "Example.COM"]);
        assert!(host_allowed("api.anthropic.com", &allowed));
        assert!(host_allowed("API.Anthropic.com", &allowed));
        assert!(host_allowed("example.com", &allowed));
        assert!(host_allowed("eu.cdn.example.com", &allowed));
        assert!(host_allowed("1.example.com", &allowed));
    }

    #[test]
    fn a_host_that_only_ends_like_an_entry_does_not_match() {
        let allowed = list(&["api.anthropic.com", "example.com"]);
        assert!(!host_allowed("anthropic.com", &allowed));
        assert!(!host_allowed("evilexample.com", &allowed));
        assert!(!host_allowed("example.com.evil.net", &allowed));
        assert!(!host_allowed(".example.com", &allowed));
        assert!(!host_allowed("", &allowed));
        assert!(!host_allowed("example.com", &list(&["", " "])));
    }

    #[test]
    fn ip_literals_never_match_in_any_form() {
        let allowed = list(&["127.0.0.1", "::1", "1", "0x7f000001", "127.1", "1.2.3.4"]);
        for host in [
            "127.0.0.1",
            "::1",
            "[::1]",
            "2130706433",
            "0x7f000001",
            "127.1",
            "0x7f.1",
            "1.2.3.4",
            "127.0.0.1.",
        ] {
            assert!(!host_allowed(host, &allowed), "{host}");
        }
    }

    #[test]
    fn loopback_link_local_and_unspecified_addresses_are_refused_in_every_form() {
        for ip in [
            "127.0.0.1",
            "127.8.9.10",
            "169.254.169.254",
            "0.0.0.0",
            "0.1.2.3",
            "::1",
            "::",
            "fe80::1",
            "febf::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:0.0.0.0",
            "::127.0.0.1",
        ] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(!address_allowed(ip), "{ip}");
        }
    }

    #[test]
    fn public_and_private_addresses_are_allowed() {
        for ip in [
            "203.0.113.7",
            "10.0.0.1",
            "192.168.1.20",
            "2001:db8::1",
            "fd00::1",
            "::ffff:203.0.113.7",
        ] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(address_allowed(ip), "{ip}");
        }
    }

    #[test]
    fn the_token_must_come_as_basic_skopos_and_the_chat_token() {
        let encoded = |credentials: &str| format!("Basic {}", STANDARD.encode(credentials));
        assert!(authorized(Some(encoded("skopos:t0k").as_str()), "t0k"));
        let lower = format!("basic {}", STANDARD.encode("skopos:t0k"));
        assert!(authorized(Some(lower.as_str()), "t0k"));
        assert!(!authorized(Some(encoded("skopos:t0kx").as_str()), "t0k"));
        assert!(!authorized(Some(encoded("agent:t0k").as_str()), "t0k"));
        let bearer = format!("Bearer {}", STANDARD.encode("skopos:t0k"));
        assert!(!authorized(Some(bearer.as_str()), "t0k"));
        assert!(!authorized(Some("Basic not-base64!"), "t0k"));
        assert!(!authorized(None, "t0k"));
        assert!(!authorized(Some(encoded("skopos:").as_str()), ""));
    }

    #[test]
    fn a_target_splits_into_its_host_and_port() {
        assert_eq!(
            split_authority("API.example.com:443"),
            Some(("api.example.com".to_owned(), Some(443)))
        );
        assert_eq!(
            split_authority("api.example.com"),
            Some(("api.example.com".to_owned(), None))
        );
        assert_eq!(
            split_authority("api.example.com:https"),
            Some(("api.example.com".to_owned(), None))
        );
        assert_eq!(
            split_authority("[2001:DB8::1]:443"),
            Some(("[2001:db8::1]".to_owned(), Some(443)))
        );
        assert_eq!(
            split_authority("::1:443"),
            Some(("::1".to_owned(), Some(443)))
        );
        assert_eq!(split_authority(":443"), None);
        assert_eq!(split_authority("[::1:443"), None);
        assert_eq!(split_authority("bad host:443"), None);
        assert_eq!(split_authority("bad%host:443"), None);
        assert_eq!(split_authority("a/b:443"), None);
    }

    #[test]
    fn a_head_with_a_bad_request_line_or_header_is_not_read() {
        for text in [
            "CONNECT api.example.com:443",
            "CONNECT api.example.com:443 HTTP/2",
            "CONNECT a b HTTP/1.1",
            "CONNECT api.example.com:443 HTTP/1.1\r\nNo colon here",
            "CONNECT api.example.com:443 HTTP/1.1\r\nBad Name: x",
            "CONNECT api.example.com:443 HTTP/1.1\r\n folded: x",
            "CONNECT api.example.com:443 HTTP/1.1\r\nHost: a\r\nHost: b",
        ] {
            assert_eq!(parse_head(text.as_bytes()), None, "{text}");
        }
        let repeated = format!(
            "CONNECT a.example:443 HTTP/1.1\r\n{}\r\n{}",
            basic("x"),
            basic("y")
        );
        assert_eq!(parse_head(repeated.as_bytes()), None);
        assert_eq!(parse_head(b"CONNECT \xff HTTP/1.1"), None);
    }

    #[test]
    fn only_an_authorized_connect_to_an_allowed_host_on_443_is_tunnelled() {
        let config = config();
        let judged = |request: &str| judge(&head(request), &config);
        let tunnel_request =
            |target: &str| format!("CONNECT {target} HTTP/1.1\r\n{}", basic("skopos:t0k"));
        assert_eq!(
            judged(&tunnel_request("api.example.com:443")),
            Verdict::Tunnel("api.example.com".to_owned())
        );
        assert_eq!(
            judged(&tunnel_request("EU.Api.Example.com:443")),
            Verdict::Tunnel("eu.api.example.com".to_owned())
        );
        for (target, host) in [
            ("api.example.com:8443", "api.example.com"),
            ("api.example.com", "api.example.com"),
            ("evil.example:443", "evil.example"),
            ("203.0.113.7:443", "203.0.113.7"),
            ("[2001:db8::1]:443", "[2001:db8::1]"),
        ] {
            assert_eq!(
                judged(&tunnel_request(target)),
                Verdict::Blocked(host.to_owned()),
                "{target}"
            );
        }
        assert_eq!(judged(&tunnel_request("bad%host:443")), Verdict::BadRequest);
        assert_eq!(
            judged("CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com"),
            Verdict::Unauthorized
        );
        assert_eq!(
            judged(&format!(
                "CONNECT api.example.com:443 HTTP/1.1\r\n{}",
                basic("skopos:wrong")
            )),
            Verdict::Unauthorized
        );
    }

    #[test]
    fn a_plain_request_is_refused_with_the_host_of_its_url_or_header() {
        let config = config();
        let judged = |request: &str| judge(&head(request), &config);
        let auth = basic("skopos:t0k");
        assert_eq!(
            judged(&format!("GET http://api.example.com/v1 HTTP/1.1\r\n{auth}")),
            Verdict::Blocked("api.example.com".to_owned())
        );
        assert_eq!(
            judged(&format!(
                "GET http://user:pw@API.example.com:8080/x?y HTTP/1.1\r\n{auth}"
            )),
            Verdict::Blocked("api.example.com".to_owned())
        );
        assert_eq!(
            judged(&format!(
                "GET / HTTP/1.1\r\nHost: api.example.com:80\r\n{auth}"
            )),
            Verdict::Blocked("api.example.com".to_owned())
        );
        assert_eq!(
            judged(&format!("GET / HTTP/1.1\r\n{auth}")),
            Verdict::BadRequest
        );
        assert_eq!(
            judged("GET http://api.example.com/ HTTP/1.1"),
            Verdict::Unauthorized
        );
    }

    #[test]
    fn each_refusal_closes_with_its_status() {
        let status = |refusal: Refusal| {
            let text = std::str::from_utf8(refusal.response()).unwrap();
            assert!(text.ends_with("\r\n\r\n"), "{text}");
            assert!(text.contains("Connection: close\r\n"), "{text}");
            text.lines().next().unwrap().to_owned()
        };
        assert_eq!(status(Refusal::BadRequest), "HTTP/1.1 400 Bad Request");
        assert_eq!(
            status(Refusal::Unauthorized),
            "HTTP/1.1 407 Proxy Authentication Required"
        );
        assert_eq!(status(Refusal::Forbidden), "HTTP/1.1 403 Forbidden");
        assert_eq!(
            status(Refusal::TooLarge),
            "HTTP/1.1 431 Request Header Fields Too Large"
        );
        assert_eq!(status(Refusal::BadGateway), "HTTP/1.1 502 Bad Gateway");
        let challenge = std::str::from_utf8(Refusal::Unauthorized.response()).unwrap();
        assert!(challenge.contains("\r\nProxy-Authenticate: Basic realm=\"skopos\"\r\n"));
    }

    #[tokio::test]
    async fn the_head_ends_at_the_blank_line_and_keeps_what_follows() {
        let (mut agent, mut proxy) = tokio::io::duplex(64 * 1024);
        agent
            .write_all(b"CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n\x16\x03\x01")
            .await
            .unwrap();
        let (head, rest) = read_head(&mut proxy).await.unwrap();
        assert_eq!(head.method, "CONNECT");
        assert_eq!(head.target, "api.example.com:443");
        assert_eq!(head.host_header.as_deref(), Some("api.example.com:443"));
        assert_eq!(head.authorization, None);
        assert_eq!(rest, b"\x16\x03\x01");
    }

    #[tokio::test]
    async fn a_head_of_16_kib_is_read_and_one_byte_more_is_too_large() {
        let (mut agent, mut proxy) = tokio::io::duplex(64 * 1024);
        agent
            .write_all(padded_head(HEAD_CAP).as_bytes())
            .await
            .unwrap();
        assert!(read_head(&mut proxy).await.is_ok());

        let (mut agent, mut proxy) = tokio::io::duplex(64 * 1024);
        agent
            .write_all(padded_head(HEAD_CAP + 1).as_bytes())
            .await
            .unwrap();
        assert_eq!(
            read_head(&mut proxy).await.unwrap_err(),
            HeadError::TooLarge
        );

        let (mut agent, mut proxy) = tokio::io::duplex(64 * 1024);
        agent.write_all(&[b'a'; HEAD_CAP + 1]).await.unwrap();
        assert_eq!(
            read_head(&mut proxy).await.unwrap_err(),
            HeadError::TooLarge
        );
    }

    #[tokio::test]
    async fn a_head_cut_short_or_unreadable_is_refused() {
        let (mut agent, mut proxy) = tokio::io::duplex(1024);
        agent
            .write_all(b"CONNECT api.example.com:443 HTTP/1.1\r\n")
            .await
            .unwrap();
        drop(agent);
        assert_eq!(read_head(&mut proxy).await.unwrap_err(), HeadError::Closed);

        let (mut agent, mut proxy) = tokio::io::duplex(1024);
        agent.write_all(b"HELLO\r\n\r\n").await.unwrap();
        assert_eq!(
            read_head(&mut proxy).await.unwrap_err(),
            HeadError::Malformed
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_that_sends_no_head_is_dropped_after_the_wait() {
        let (mut agent, proxy_side) = tokio::io::duplex(1024);
        let (blocked, _reports) = mpsc::channel(1);
        let shared = Shared::new(config(), blocked, HTTPS_PORT);
        let handled = tokio::time::timeout(HEAD_WAIT * 2, handle(Box::new(proxy_side), shared));
        assert!(
            handled.await.is_ok(),
            "the proxy gives up on a silent client"
        );
        let mut rest = Vec::new();
        agent.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty(), "a silent client gets no answer");
    }
}
