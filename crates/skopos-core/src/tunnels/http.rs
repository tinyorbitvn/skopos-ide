//! The bits of HTTP/1.1 the gateway and the CONNECT client share (tunnels spec §5.5, §5.6).

use std::io::{Error, ErrorKind};

use tokio::io::{AsyncRead, AsyncReadExt};

use crate::error::sanitize_text;

/// The longest status reason the gateway sends (spec §5.5).
const REASON_MAX: usize = 200;

/// Reads up to and with the blank line, one byte at a time so nothing after the head is taken.
pub(crate) async fn read_head<S: AsyncRead + Unpin>(
    stream: &mut S,
    cap: usize,
) -> std::io::Result<String> {
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= cap {
            return Err(Error::new(ErrorKind::InvalidData, "the head is too long"));
        }
        if stream.read(&mut byte).await? == 0 {
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "the connection closed",
            ));
        }
        head.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

/// `host:port`, an IPv6 address in brackets.
pub(crate) fn authority(host: &str, port: u16) -> String {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.contains(':') {
        format!("[{bare}]:{port}")
    } else {
        format!("{bare}:{port}")
    }
}

/// One sanitized line without control characters, at most 200 characters.
pub(crate) fn status_reason(text: &str) -> String {
    sanitize_text(text)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(REASON_MAX)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_brackets_ipv6() {
        assert_eq!(authority("::1", 443), "[::1]:443");
        assert_eq!(authority("[::1]", 443), "[::1]:443");
        assert_eq!(authority("api.internal", 6443), "api.internal:6443");
    }

    #[test]
    fn a_status_reason_is_one_bounded_line() {
        assert_eq!(status_reason("a\r\nb"), "a  b");
        assert_eq!(status_reason(&"x".repeat(300)).chars().count(), 200);
    }

    #[tokio::test]
    async fn read_head_stops_at_the_blank_line_and_caps() {
        let mut input: &[u8] = b"HTTP/1.1 200 OK\r\n\r\nrest";
        assert_eq!(
            read_head(&mut input, 64).await.unwrap(),
            "HTTP/1.1 200 OK\r\n\r\n"
        );
        assert_eq!(input, b"rest");
        let mut long: &[u8] = &[b'a'; 100];
        assert!(read_head(&mut long, 64).await.is_err());
    }
}
