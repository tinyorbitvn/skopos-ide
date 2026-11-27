//! Who listens on the local `-D` port of an SSH tunnel.
//!
//! The port is picked free, released, then bound by `ssh` only after it logged in. Another
//! user's program can bind it first; a successful connect would then send cluster traffic to
//! that program. On Linux `/proc` names the owner of every listening socket, so the port counts
//! as `ssh`'s only while every listener on it is this user's. Elsewhere the port is taken on
//! trust, like the `-D` port itself (spec §11).

/// What the system says about the listeners on a local port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// Only Linux tells owners apart; elsewhere every port is `Unknown`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) enum Listener {
    /// Every listener on the port runs as this user.
    Ours,
    /// Another user's program listens on the port.
    Other,
    /// Nothing listens on the port yet.
    Missing,
    /// The system cannot tell (not Linux, or `/proc` cannot be read).
    Unknown,
}

/// The listeners on `port`, on any address: a wildcard or IPv6 listener also takes connects
/// to `127.0.0.1`. Checked before anything connects to the port.
pub(crate) async fn listener_on(port: u16) -> Listener {
    #[cfg(target_os = "linux")]
    {
        tokio::task::spawn_blocking(move || linux::listener_on(port))
            .await
            .unwrap_or(Listener::Unknown)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = port;
        Listener::Unknown
    }
}

/// The owners (uids) of the sockets in a `/proc/net/tcp` or `/proc/net/tcp6` table that listen
/// on `port`.
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

/// The verdict on the listeners' owners. `uids` is `None` when no table could be read.
#[cfg(any(test, target_os = "linux"))]
fn verdict(uids: Option<Vec<u32>>, ours: u32) -> Listener {
    match uids {
        None => Listener::Unknown,
        Some(uids) if uids.iter().any(|&uid| uid != ours) => Listener::Other,
        Some(uids) if uids.is_empty() => Listener::Missing,
        Some(_) => Listener::Ours,
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{listener_uids, verdict, Listener};

    pub(super) fn listener_on(port: u16) -> Listener {
        let mut uids: Option<Vec<u32>> = None;
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(text) = std::fs::read_to_string(table) {
                uids.get_or_insert_with(Vec::new)
                    .extend(listener_uids(&text, port));
            }
        }
        // SAFETY: `geteuid` takes no arguments and cannot fail.
        verdict(uids, unsafe { libc::geteuid() })
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

    #[test]
    fn one_foreign_listener_is_enough_to_refuse_the_port() {
        assert_eq!(verdict(Some(vec![1000]), 1000), Listener::Ours);
        assert_eq!(verdict(Some(vec![1000, 1001]), 1000), Listener::Other);
        assert_eq!(verdict(Some(vec![1001]), 1000), Listener::Other);
        // Nothing seen is not up yet, never a pass.
        assert_eq!(verdict(Some(Vec::new()), 1000), Listener::Missing);
        assert_eq!(verdict(None, 1000), Listener::Unknown);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_port_this_user_listens_on_is_ours() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(listener_on(port).await, Listener::Ours);
        drop(listener);
        assert_eq!(listener_on(port).await, Listener::Missing);
    }
}
