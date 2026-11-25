//! The per-chat MCP listener (native agents spec §4.2): an ephemeral `127.0.0.1` port that
//! accepts only the chat's token, which `new_token` makes, as the first line of a connection
//! (`read_token_line`).

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
    /// An ephemeral port on `127.0.0.1`.
    Tcp,
}

/// A connection an `Endpoint` accepted.
pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}

/// One chat's listener. Dropping it closes the listener.
pub struct Endpoint {
    listener: TcpListener,
    port: u16,
}

impl Endpoint {
    /// Starts listening.
    pub async fn bind(listen: Listen) -> CoreResult<Endpoint> {
        match listen {
            Listen::Tcp => {
                let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
                let port = listener.local_addr()?.port();
                Ok(Endpoint { listener, port })
            }
        }
    }

    /// The port it listens on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Waits for the next connection.
    pub async fn accept(&self) -> std::io::Result<Box<dyn AsyncStream>> {
        let (stream, _) = self.listener.accept().await?;
        Ok(Box::new(stream))
    }
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
        let port = endpoint.port();
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
}
