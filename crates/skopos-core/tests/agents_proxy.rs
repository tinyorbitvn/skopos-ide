//! The per-chat proxy end to end over its listeners (spec §4.7, §6.6, §6.7).
#![cfg(unix)]

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use skopos_core::agents::endpoint::{new_token, Endpoint, Listen};
use skopos_core::agents::proxy::{self, ProxyConfig, Resolver};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(10);
const FORBIDDEN: &str = "HTTP/1.1 403 Forbidden";

/// A running proxy on a TCP endpoint; dropping it stops the proxy.
struct Proxy {
    port: u16,
    token: String,
    blocked: mpsc::Receiver<String>,
    cancel: CancellationToken,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Starts a proxy that allows `hosts` and resolves through `answers` (host, address).
/// With `upstream_port`, allowed tunnels go to that port instead of 443.
async fn start(hosts: &[&str], answers: &[(&str, &str)], upstream_port: Option<u16>) -> Proxy {
    let endpoint = Endpoint::bind(Listen::Tcp).await.unwrap();
    let port = endpoint.port().expect("a TCP endpoint has a port");
    let token = new_token();
    let mut fixed: HashMap<String, Vec<IpAddr>> = HashMap::new();
    for (host, ip) in answers {
        fixed
            .entry((*host).to_owned())
            .or_default()
            .push(ip.parse().unwrap());
    }
    let config = ProxyConfig {
        token: token.clone(),
        hosts: hosts.iter().map(|host| (*host).to_owned()).collect(),
        resolve: Resolver::Fixed(fixed),
    };
    let (reports, blocked) = mpsc::channel(16);
    let cancel = CancellationToken::new();
    match upstream_port {
        Some(upstream) => tokio::spawn(proxy::serve_for_test(
            endpoint,
            config,
            reports,
            cancel.clone(),
            upstream,
        )),
        None => tokio::spawn(proxy::serve(endpoint, config, reports, cancel.clone())),
    };
    Proxy {
        port,
        token,
        blocked,
        cancel,
    }
}

/// The `Proxy-Authorization` header line of the proxy URL `http://skopos:<token>@…`.
fn credentials(token: &str) -> String {
    format!(
        "Proxy-Authorization: Basic {}\r\n",
        STANDARD.encode(format!("skopos:{token}"))
    )
}

fn connect_head(target: &str, token: &str) -> String {
    format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{}\r\n",
        credentials(token)
    )
}

/// Reads the answer's head byte by byte, so nothing after it is taken, and gives its
/// status line.
async fn read_status(stream: &mut (impl AsyncRead + Unpin)) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap() == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8(head).unwrap();
    text.lines().next().unwrap_or_default().to_owned()
}

/// Sends `head` on a new connection and gives the answer's status line.
async fn ask(proxy: &Proxy, head: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port)).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    timeout(WAIT, read_status(&mut stream))
        .await
        .expect("the proxy answers")
}

/// The address this machine would send from, found without sending anything: connecting
/// a UDP socket only picks a route. `None` when there is no route, or only to an address
/// the proxy refuses.
fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if proxy::address_allowed(IpAddr::V4(ip)) => Some(ip),
        _ => None,
    }
}

#[tokio::test]
async fn a_wrong_or_missing_token_gets_407() {
    let mut proxy = start(
        &["api.example.com"],
        &[("api.example.com", "203.0.113.7")],
        None,
    )
    .await;
    let wrong = connect_head("api.example.com:443", "0123456789abcdef0123456789abcdef");
    assert_eq!(
        ask(&proxy, &wrong).await,
        "HTTP/1.1 407 Proxy Authentication Required"
    );
    let missing = "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n";
    assert_eq!(
        ask(&proxy, missing).await,
        "HTTP/1.1 407 Proxy Authentication Required"
    );
    assert!(
        proxy.blocked.try_recv().is_err(),
        "a client without the token is not reported"
    );
}

#[tokio::test]
async fn plain_http_is_refused_and_its_host_reported() {
    let mut proxy = start(&["api.example.com"], &[], None).await;
    let head = format!(
        "GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n{}\r\n",
        credentials(&proxy.token)
    );
    assert_eq!(ask(&proxy, &head).await, FORBIDDEN);
    assert_eq!(
        proxy.blocked.try_recv().ok().as_deref(),
        Some("api.example.com")
    );
}

#[tokio::test]
async fn a_port_other_than_443_is_refused() {
    let mut proxy = start(
        &["api.example.com"],
        &[("api.example.com", "203.0.113.7")],
        None,
    )
    .await;
    let head = connect_head("api.example.com:80", &proxy.token);
    assert_eq!(ask(&proxy, &head).await, FORBIDDEN);
    assert_eq!(
        proxy.blocked.try_recv().ok().as_deref(),
        Some("api.example.com")
    );
}

#[tokio::test]
async fn an_ip_literal_is_refused_even_when_listed() {
    let mut proxy = start(&["203.0.113.7"], &[], None).await;
    for (target, host) in [
        ("203.0.113.7:443", "203.0.113.7"),
        ("[2001:db8::1]:443", "[2001:db8::1]"),
    ] {
        let head = connect_head(target, &proxy.token);
        assert_eq!(ask(&proxy, &head).await, FORBIDDEN, "{target}");
        assert_eq!(proxy.blocked.try_recv().ok().as_deref(), Some(host));
    }
}

#[tokio::test]
async fn a_host_off_the_list_is_refused_and_reported_once() {
    let mut proxy = start(&["api.example.com"], &[], None).await;
    for _ in 0..2 {
        let head = connect_head("evil.example:443", &proxy.token);
        assert_eq!(ask(&proxy, &head).await, FORBIDDEN);
    }
    // The report goes out before the answer, so both have been made by now.
    assert_eq!(
        proxy.blocked.try_recv().ok().as_deref(),
        Some("evil.example")
    );
    assert!(proxy.blocked.try_recv().is_err(), "a host is reported once");

    let head = connect_head("other.example:443", &proxy.token);
    assert_eq!(ask(&proxy, &head).await, FORBIDDEN);
    assert_eq!(
        proxy.blocked.try_recv().ok().as_deref(),
        Some("other.example")
    );
}

#[tokio::test]
async fn an_allowed_name_that_resolves_to_loopback_is_refused() {
    // A listener of the person's (a port-forward, say) that the name points at.
    let home = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let home_port = home.local_addr().unwrap().port();
    let mut proxy = start(
        &["internal.example"],
        &[("internal.example", "127.0.0.1")],
        Some(home_port),
    )
    .await;
    let head = connect_head("internal.example:443", &proxy.token);
    assert_eq!(ask(&proxy, &head).await, FORBIDDEN);
    assert_eq!(
        proxy.blocked.try_recv().ok().as_deref(),
        Some("internal.example")
    );
    assert!(
        timeout(Duration::from_millis(300), home.accept())
            .await
            .is_err(),
        "nothing reached the loopback listener"
    );
}

#[tokio::test]
async fn an_allowed_name_with_a_link_local_or_mapped_loopback_address_is_refused() {
    let mut proxy = start(
        &["example.com"],
        &[
            ("metadata.example.com", "169.254.169.254"),
            ("mapped.example.com", "::ffff:127.0.0.1"),
            ("mixed.example.com", "203.0.113.7"),
            ("mixed.example.com", "127.0.0.1"),
        ],
        None,
    )
    .await;
    for host in [
        "metadata.example.com",
        "mapped.example.com",
        "mixed.example.com",
    ] {
        let head = connect_head(&format!("{host}:443"), &proxy.token);
        assert_eq!(ask(&proxy, &head).await, FORBIDDEN, "{host}");
        assert_eq!(proxy.blocked.try_recv().ok().as_deref(), Some(host));
    }
}

#[tokio::test]
async fn an_allowed_host_that_does_not_resolve_gets_502() {
    let mut proxy = start(&["api.example.com"], &[], None).await;
    let head = connect_head("api.example.com:443", &proxy.token);
    assert_eq!(ask(&proxy, &head).await, "HTTP/1.1 502 Bad Gateway");
    assert!(
        proxy.blocked.try_recv().is_err(),
        "a lookup failure is no block"
    );
}

#[tokio::test]
async fn an_allowed_host_is_tunnelled_with_the_bytes_sent_early() {
    let Some(ip) = local_ipv4() else {
        eprintln!("skipped: this machine has no non-loopback IPv4 address");
        return;
    };
    let server = TcpListener::bind((ip, 0)).await.unwrap();
    let server_port = server.local_addr().unwrap().port();
    let served = tokio::spawn(async move {
        let (mut stream, _) = server.accept().await.unwrap();
        let mut ping = [0u8; 4];
        stream.read_exact(&mut ping).await.unwrap();
        assert_eq!(&ping, b"ping");
        stream.write_all(b"pong").await.unwrap();
    });
    let ip = ip.to_string();
    let mut proxy = start(
        &["api.example.com"],
        &[("eu.api.example.com", ip.as_str())],
        Some(server_port),
    )
    .await;

    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port)).await.unwrap();
    let head = connect_head("eu.api.example.com:443", &proxy.token);
    // A client may start its TLS handshake without waiting for the answer.
    stream
        .write_all(format!("{head}ping").as_bytes())
        .await
        .unwrap();
    let status = timeout(WAIT, read_status(&mut stream)).await.unwrap();
    assert_eq!(status, "HTTP/1.1 200 Connection established");
    let mut pong = [0u8; 4];
    timeout(WAIT, stream.read_exact(&mut pong))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&pong, b"pong");
    served.await.unwrap();
    assert!(proxy.blocked.try_recv().is_err(), "nothing was blocked");
}

#[tokio::test]
async fn a_request_head_over_16_kib_is_refused() {
    let proxy = start(&["api.example.com"], &[], None).await;
    let start_line = "CONNECT api.example.com:443 HTTP/1.1\r\nX-Pad: ";
    let head = format!(
        "{start_line}{}",
        "a".repeat(proxy::HEAD_CAP + 1 - start_line.len())
    );
    assert_eq!(
        ask(&proxy, &head).await,
        "HTTP/1.1 431 Request Header Fields Too Large"
    );
}

#[tokio::test]
async fn the_proxy_stops_listening_when_cancelled() {
    let proxy = start(&[], &[], None).await;
    let port = proxy.port;
    proxy.cancel.cancel();
    let closed = async {
        while TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    timeout(WAIT, closed)
        .await
        .expect("the listener closes once the proxy is cancelled");
}

#[tokio::test]
async fn the_proxy_serves_a_unix_socket_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("proxy.sock");
    let endpoint = Endpoint::bind(Listen::Unix(path.clone())).await.unwrap();
    let token = new_token();
    let config = ProxyConfig {
        token: token.clone(),
        hosts: Vec::new(),
        resolve: Resolver::Fixed(HashMap::new()),
    };
    let (reports, mut blocked) = mpsc::channel(4);
    let cancel = CancellationToken::new();
    let served = tokio::spawn(proxy::serve(endpoint, config, reports, cancel.clone()));

    let mut stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    stream
        .write_all(connect_head("evil.example:443", &token).as_bytes())
        .await
        .unwrap();
    let status = timeout(WAIT, read_status(&mut stream)).await.unwrap();
    assert_eq!(status, FORBIDDEN);
    assert_eq!(blocked.try_recv().ok().as_deref(), Some("evil.example"));

    cancel.cancel();
    timeout(WAIT, served).await.unwrap().unwrap();
    assert!(!path.exists(), "the socket file goes with the proxy");
}
