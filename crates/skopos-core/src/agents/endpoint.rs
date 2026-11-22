//! The per-chat listeners (spec §4.1). A chat's MCP endpoint and its proxy each listen on
//! a Unix socket in the chat's `0700` run folder (Linux, where bubblewrap binds that folder
//! into the sandbox) or on an ephemeral `127.0.0.1` port (macOS, and with the sandbox off
//! for tests). Both accept only the chat's token, which `new_token` makes: the MCP endpoint
//! as the first line of a connection (`read_token_line`), the proxy in its
//! `Proxy-Authorization` header.

use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::net::TcpListener;

use crate::error::CoreResult;

/// How long a client may take to send its token line.
const TOKEN_WAIT: Duration = Duration::from_secs(10);
/// The longest token line read; a token is 32 characters.
const TOKEN_LINE_CAP: usize = 128;

/// Where a chat's listener waits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listen {
    /// A Unix socket at this path, in a folder that exists. Unix only: elsewhere `bind`
    /// answers `Unsupported`.
    Unix(PathBuf),
    /// An ephemeral port on `127.0.0.1`.
    Tcp,
}

/// A connection an `Endpoint` accepted, over either kind of listener.
pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}

/// One chat's listener. Dropping it closes the listener and removes its Unix socket file.
pub struct Endpoint {
    bound: Bound,
    port: Option<u16>,
}

enum Bound {
    #[cfg(unix)]
    Unix {
        listener: tokio::net::UnixListener,
        // After the listener, so the socket closes before its file goes.
        _file: SocketFile,
    },
    Tcp(TcpListener),
}

/// A socket file, removed when dropped.
#[cfg(unix)]
struct SocketFile(PathBuf);

#[cfg(unix)]
impl Drop for SocketFile {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                tracing::debug!("cannot remove {}: {error}", self.0.display());
            }
            _ => {}
        }
    }
}

impl Endpoint {
    /// Starts listening. A Unix socket's path is cleared first, and the socket is made
    /// readable and writable by its owner only, like the run folder it sits in.
    pub async fn bind(listen: Listen) -> CoreResult<Endpoint> {
        match listen {
            #[cfg(unix)]
            Listen::Unix(path) => bind_unix(path),
            #[cfg(not(unix))]
            Listen::Unix(_) => Err(crate::error::IpcError::new(
                crate::error::ErrorCode::Unsupported,
                "Agents are not available on Windows.",
            )),
            Listen::Tcp => {
                let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
                let port = listener.local_addr()?.port();
                Ok(Endpoint {
                    bound: Bound::Tcp(listener),
                    port: Some(port),
                })
            }
        }
    }

    /// The TCP port; `None` on a Unix socket.
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// Waits for the next connection.
    pub async fn accept(&self) -> std::io::Result<Box<dyn AsyncStream>> {
        match &self.bound {
            #[cfg(unix)]
            Bound::Unix { listener, .. } => {
                let (stream, _) = listener.accept().await?;
                Ok(Box::new(stream))
            }
            Bound::Tcp(listener) => {
                let (stream, _) = listener.accept().await?;
                Ok(Box::new(stream))
            }
        }
    }
}

#[cfg(unix)]
fn bind_unix(path: PathBuf) -> CoreResult<Endpoint> {
    // A file left at the path would make the bind fail.
    match std::fs::remove_file(&path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    let file = SocketFile(path);
    std::fs::set_permissions(
        &file.0,
        <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o600),
    )?;
    Ok(Endpoint {
        bound: Bound::Unix {
            listener,
            _file: file,
        },
        port: None,
    })
}

/// A chat's token: 32 hex characters from the system's secure random source.
pub fn new_token() -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0u8; 16];
    let random = rustls::crypto::ring::default_provider().secure_random;
    rustls::crypto::SecureRandom::fill(random, &mut bytes)
        .expect("the system's secure random source works");
    bytes
        .iter()
        .flat_map(|byte| [HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 0x0f)]])
        .map(char::from)
        .collect()
}

/// Reads the first line of a connection and tells whether it is `token` (spec §4.1:
/// `--agent-mcp` sends the chat's token first). It reads byte by byte up to the newline,
/// so what follows stays in the stream, and gives up after 10 s or 128 bytes.
pub async fn read_token_line<S: AsyncRead + Unpin + ?Sized>(stream: &mut S, token: &str) -> bool {
    let read = async {
        let mut line = Vec::with_capacity(token.len());
        loop {
            let byte = stream.read_u8().await.ok()?;
            if byte == b'\n' {
                return Some(line);
            }
            if line.len() == TOKEN_LINE_CAP {
                return None;
            }
            line.push(byte);
        }
    };
    match tokio::time::timeout(TOKEN_WAIT, read).await {
        Ok(Some(line)) => same_bytes(&line, token.as_bytes()),
        Ok(None) | Err(_) => false,
    }
}

/// Compares two byte strings in a time that depends only on their lengths, so a wrong
/// token's answer says nothing about how much of it was right.
pub(crate) fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn a_token_is_32_hex_characters_and_new_each_time() {
        let first = new_token();
        let second = new_token();
        assert_eq!(first.len(), 32);
        assert!(first
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_ne!(first, second);
    }

    #[test]
    fn bytes_compare_equal_only_when_they_are_the_same() {
        assert!(same_bytes(b"abc", b"abc"));
        assert!(same_bytes(b"", b""));
        assert!(!same_bytes(b"abc", b"abd"));
        assert!(!same_bytes(b"abc", b"abcd"));
    }

    #[tokio::test]
    async fn the_token_line_must_be_the_token_and_what_follows_stays_in_the_stream() {
        let (mut agent, mut endpoint) = tokio::io::duplex(1024);
        agent
            .write_all(b"0123abcd\n{\"jsonrpc\":\"2.0\"}")
            .await
            .unwrap();
        assert!(read_token_line(&mut endpoint, "0123abcd").await);
        let mut rest = [0u8; 17];
        endpoint.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"{\"jsonrpc\":\"2.0\"}");
    }

    #[tokio::test]
    async fn a_wrong_short_long_or_cut_token_line_is_refused() {
        let cases: [&[u8]; 4] = [b"0123abce\n", b"0123abc\n", b"0123abcd0\n", b"0123abcd"];
        for sent in cases {
            let (mut agent, mut endpoint) = tokio::io::duplex(1024);
            agent.write_all(sent).await.unwrap();
            drop(agent);
            assert!(
                !read_token_line(&mut endpoint, "0123abcd").await,
                "{sent:?}"
            );
        }
        // A line that never ends is cut at the cap, whatever the token.
        let (mut agent, mut endpoint) = tokio::io::duplex(4096);
        agent.write_all(&[b'a'; TOKEN_LINE_CAP + 1]).await.unwrap();
        let long = "a".repeat(TOKEN_LINE_CAP + 1);
        assert!(!read_token_line(&mut endpoint, &long).await);
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_that_sends_nothing_is_refused_after_the_wait() {
        let (_agent, mut endpoint) = tokio::io::duplex(64);
        assert!(!read_token_line(&mut endpoint, "0123abcd").await);
    }

    #[tokio::test]
    async fn a_tcp_endpoint_listens_on_a_loopback_port() {
        let endpoint = Endpoint::bind(Listen::Tcp).await.unwrap();
        let port = endpoint.port().expect("a TCP endpoint has a port");
        let client = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream.write_all(b"hi").await.unwrap();
        });
        let mut accepted = endpoint.accept().await.unwrap();
        let mut got = [0u8; 2];
        accepted.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hi");
        client.await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_unix_endpoint_is_private_to_its_user_and_removed_when_dropped() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.sock");
        // A file an earlier run left behind does not keep the endpoint from starting.
        std::fs::write(&path, b"left over").unwrap();
        let endpoint = Endpoint::bind(Listen::Unix(path.clone())).await.unwrap();
        assert_eq!(endpoint.port(), None);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        let client = tokio::spawn({
            let path = path.clone();
            async move {
                let mut stream = tokio::net::UnixStream::connect(path).await.unwrap();
                stream.write_all(b"hi").await.unwrap();
            }
        });
        let mut accepted = endpoint.accept().await.unwrap();
        let mut got = [0u8; 2];
        accepted.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hi");
        client.await.unwrap();

        drop(accepted);
        drop(endpoint);
        assert!(!path.exists(), "the socket file goes with the endpoint");
    }
}
