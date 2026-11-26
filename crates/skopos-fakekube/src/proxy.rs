//! Test proxies for the tunnel tests: an HTTP CONNECT proxy and a SOCKS5 proxy, each with an
//! optional user name and password, and an echo server to reach through them. Not shipped.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use base64::Engine;
use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// The targets a proxy was asked for, as written in each request.
#[derive(Clone, Default)]
pub struct Seen(Arc<Mutex<Vec<String>>>);

impl Seen {
    pub fn targets(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
    fn push(&self, target: String) {
        self.0.lock().unwrap().push(target);
    }
}

#[derive(Clone, Default)]
pub struct ProxyOptions {
    pub credentials: Option<(String, String)>,
    /// Names the proxy resolves itself, as the far side's DNS would.
    pub hosts: HashMap<String, SocketAddr>,
    /// Answers every CONNECT with this status (such as `403 Forbidden by policy`).
    pub refuse_with: Option<String>,
}

pub struct TestProxy {
    pub addr: SocketAddr,
    pub seen: Seen,
    task: JoinHandle<()>,
}

impl Drop for TestProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct TestServer {
    pub addr: SocketAddr,
    task: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Writes back whatever it reads.
pub async fn echo_server() -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = stream.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    TestServer { addr, task }
}

async fn dial(options: &ProxyOptions, host: &str, port: u16) -> std::io::Result<TcpStream> {
    match options.hosts.get(host) {
        Some(addr) => TcpStream::connect(addr).await,
        None => {
            TcpStream::connect((host.trim_start_matches('[').trim_end_matches(']'), port)).await
        }
    }
}

pub async fn http_proxy(options: ProxyOptions) -> TestProxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Seen::default();
    let task = {
        let seen = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(http_one(stream, options.clone(), seen.clone()));
            }
        })
    };
    TestProxy { addr, seen, task }
}

async fn http_one(mut client: TcpStream, options: ProxyOptions, seen: Seen) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
        if client.read(&mut byte).await.unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let target = head.split(' ').nth(1).unwrap_or_default().to_owned();
    seen.push(target.clone());
    if let Some((user, password)) = &options.credentials {
        let expected =
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        let sent = head.lines().any(|line| {
            line.to_ascii_lowercase()
                .starts_with("proxy-authorization:")
                && line.ends_with(&format!("Basic {expected}"))
        });
        if !sent {
            let _ = client
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await;
            return;
        }
    }
    if let Some(status) = &options.refuse_with {
        let _ = client
            .write_all(format!("HTTP/1.1 {status}\r\n\r\n").as_bytes())
            .await;
        return;
    }
    let Some((host, port)) = target.rsplit_once(':') else {
        return;
    };
    let Ok(port) = port.parse::<u16>() else {
        return;
    };
    let Ok(mut upstream) = dial(&options, host, port).await else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
        return;
    };
    if client
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .await
        .is_ok()
    {
        let _ = copy_bidirectional(&mut client, &mut upstream).await;
    }
}

pub async fn socks5_proxy(options: ProxyOptions) -> TestProxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Seen::default();
    let task = {
        let seen = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(socks_one(stream, options.clone(), seen.clone()));
            }
        })
    };
    TestProxy { addr, seen, task }
}

async fn socks_one(
    mut client: TcpStream,
    options: ProxyOptions,
    seen: Seen,
) -> std::io::Result<()> {
    let mut greeting = [0u8; 2];
    client.read_exact(&mut greeting).await?;
    let mut methods = vec![0u8; usize::from(greeting[1])];
    client.read_exact(&mut methods).await?;
    match &options.credentials {
        Some((user, password)) => {
            if !methods.contains(&2) {
                client.write_all(&[5, 0xff]).await?;
                return Ok(());
            }
            client.write_all(&[5, 2]).await?;
            let mut version_and_len = [0u8; 2];
            client.read_exact(&mut version_and_len).await?;
            let mut name = vec![0u8; usize::from(version_and_len[1])];
            client.read_exact(&mut name).await?;
            let mut len = [0u8; 1];
            client.read_exact(&mut len).await?;
            let mut pass = vec![0u8; usize::from(len[0])];
            client.read_exact(&mut pass).await?;
            if name != user.as_bytes() || pass != password.as_bytes() {
                client.write_all(&[1, 1]).await?;
                return Ok(());
            }
            client.write_all(&[1, 0]).await?;
        }
        None => client.write_all(&[5, 0]).await?,
    }
    let mut request = [0u8; 4];
    client.read_exact(&mut request).await?;
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            client.read_exact(&mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            client.read_exact(&mut len).await?;
            let mut name = vec![0u8; usize::from(len[0])];
            client.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        _ => {
            let mut ip = [0u8; 16];
            client.read_exact(&mut ip).await?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
    };
    let mut port = [0u8; 2];
    client.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);
    seen.push(format!("{host}:{port}"));
    let Ok(mut upstream) = dial(&options, &host, port).await else {
        client.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    };
    client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}
