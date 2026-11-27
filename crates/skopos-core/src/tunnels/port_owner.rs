//! Who listens on the local `-D` port of an SSH tunnel.
//!
//! The port is picked free, released, then bound by `ssh` only after it logged in. Another
//! user's program can bind it first; a successful connect would then send cluster traffic to
//! that program. On Linux `/proc` names the owner of every listening socket, so a port that
//! another user holds is never taken for `ssh`'s. Elsewhere the port is taken on trust, like the
//! `-D` port itself (spec §11).

/// Whether the program that listens on `127.0.0.1:<port>` runs as this user. `true` when the
/// system cannot tell.
pub(crate) async fn listener_is_ours(port: u16) -> bool {
    #[cfg(target_os = "linux")]
    {
        tokio::task::spawn_blocking(move || linux::listeners_are_ours(port) != Some(false))
            .await
            .unwrap_or(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = port;
        true
    }
}

/// The owners (uids) of the sockets in a `/proc/net/tcp` or `/proc/net/tcp6` table that listen
/// on `port`, on any address: a wildcard or IPv6 listener also takes connects to `127.0.0.1`.
#[cfg(any(test, target_os = "linux"))]
fn listener_uids(table: &str, port: u16) -> Vec<u32> {
    const LISTEN: &str = "0A";
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (_, local_port) = fields.get(1)?.rsplit_once(':')?;
            let listens = *fields.get(3)? == LISTEN;
            let on_port = u16::from_str_radix(local_port, 16).ok()? == port;
            if listens && on_port {
                fields.get(7)?.parse().ok()
            } else {
                None
            }
        })
        .collect()
}

#[cfg(target_os = "linux")]
mod linux {
    use super::listener_uids;

    /// `Some(false)` when a socket on `port` belongs to another user, `None` when `/proc`
    /// shows no listener on it.
    pub(super) fn listeners_are_ours(port: u16) -> Option<bool> {
        // SAFETY: `geteuid` takes no arguments and cannot fail.
        let uid = unsafe { libc::geteuid() };
        let mut seen = false;
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            let Ok(text) = std::fs::read_to_string(table) else {
                continue;
            };
            for owner in listener_uids(&text, port) {
                if owner != uid {
                    return Some(false);
                }
                seen = true;
            }
        }
        seen.then_some(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:A1B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0
   1: 00000000:A1B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 41002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:A1B2 0100007F:C3D4 01 00000000:00000000 00:00000000 00000000  1002        0 41003 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1003        0 41004 1 0000000000000000 100 0 0 10 0
";

    #[test]
    fn only_listening_sockets_on_the_port_count() {
        // Port 0xA1B2: the loopback and the wildcard listener; the connected socket is not one.
        assert_eq!(listener_uids(TABLE, 0xA1B2), vec![1000, 1001]);
        assert_eq!(listener_uids(TABLE, 0x1F90), vec![1003]);
        assert!(listener_uids(TABLE, 22).is_empty());
        assert!(listener_uids("", 22).is_empty());
        assert!(listener_uids("header\n garbage line\n", 22).is_empty());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_port_this_user_listens_on_is_ours() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(linux::listeners_are_ours(port), Some(true));
        assert!(listener_is_ours(port).await);
        drop(listener);
        assert_eq!(linux::listeners_are_ours(port), None);
    }
}
