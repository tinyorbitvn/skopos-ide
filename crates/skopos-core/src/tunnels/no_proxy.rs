//! `NO_PROXY` the way client-go reads it (tunnels spec §5.8). `kube`'s own matcher is not
//! public and checks the proxy's address instead of the API server's.

use std::net::IpAddr;

use super::runtime::host_port;

/// Whether `host` (any case, an IPv6 address with or without brackets) at `port` skips the
/// proxy under `no_proxy`: `*`, a name and its subdomains, `.name` or `*.name` for subdomains
/// only, an optional `:port`, an IP address, or a CIDR.
pub(crate) fn exempt(no_proxy: &str, host: &str, port: u16) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let ip = host.parse::<IpAddr>().ok();
    no_proxy
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .any(|entry| matches_entry(&entry.to_ascii_lowercase(), &host, ip, port))
}

fn matches_entry(entry: &str, host: &str, ip: Option<IpAddr>, port: u16) -> bool {
    if entry == "*" {
        return true;
    }
    if let Some((net, bits)) = entry.split_once('/') {
        return match (ip, net.parse::<IpAddr>(), bits.parse::<u8>()) {
            (Some(ip), Ok(net), Ok(bits)) => in_cidr(ip, net, bits),
            _ => false,
        };
    }
    let (name, entry_port) = split_port(entry);
    if entry_port.is_some_and(|wanted| wanted != port) {
        return false;
    }
    if let Ok(entry_ip) = name.parse::<IpAddr>() {
        return ip == Some(entry_ip);
    }
    let subdomains_only = name.starts_with('.') || name.starts_with("*.");
    let domain = name.trim_start_matches('*').trim_start_matches('.');
    if domain.is_empty() {
        return false;
    }
    host.ends_with(&format!(".{domain}")) || (!subdomains_only && host == domain)
}

/// `name` and its port, an IPv6 address in brackets.
fn split_port(entry: &str) -> (&str, Option<u16>) {
    if let Some(rest) = entry.strip_prefix('[') {
        return match rest.split_once(']') {
            Some((name, after)) => (name, after.strip_prefix(':').and_then(|p| p.parse().ok())),
            None => (entry, None),
        };
    }
    match entry.split_once(':') {
        Some((name, port)) if !port.contains(':') => (name, port.parse().ok()),
        _ => (entry, None),
    }
}

fn in_cidr(ip: IpAddr, net: IpAddr, bits: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) if bits <= 32 => {
            let mask = u32::MAX.checked_shl(32 - u32::from(bits)).unwrap_or(0);
            u32::from(ip) & mask == u32::from(net) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) if bits <= 128 => {
            let mask = u128::MAX.checked_shl(128 - u32::from(bits)).unwrap_or(0);
            u128::from(ip) & mask == u128::from(net) & mask
        }
        _ => false,
    }
}

/// The proxy from the environment for an API server, as `kube` picks it (`HTTPS_PROXY`, then
/// `https_proxy`), unless the server is this machine or `NO_PROXY` / `no_proxy` exempts it.
pub(crate) fn env_proxy(server: &str, var: impl Fn(&str) -> Option<String>) -> Option<String> {
    let set = |name: &str| var(name).filter(|value| !value.trim().is_empty());
    let proxy = set("HTTPS_PROXY").or_else(|| set("https_proxy"))?;
    let Some((host, port)) = host_port(server) else {
        return Some(proxy);
    };
    let loopback = host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let no_proxy = set("NO_PROXY")
        .or_else(|| set("no_proxy"))
        .unwrap_or_default();
    (!loopback && !exempt(&no_proxy, &host, port)).then_some(proxy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_like_client_go() {
        assert!(exempt("example.com", "example.com", 443));
        assert!(exempt("example.com", "api.example.com", 443));
        assert!(!exempt(".example.com", "example.com", 443));
        assert!(exempt(".example.com", "api.example.com", 443));
        assert!(exempt("*.example.com", "api.example.com", 443));
        assert!(!exempt("example.com", "badexample.com", 443));
        assert!(exempt(" other.org , EXAMPLE.com ", "api.example.com", 443));
        assert!(exempt("*", "anything", 1));
        assert!(!exempt("", "example.com", 443));
    }

    #[test]
    fn ports_ips_and_cidrs_match() {
        assert!(!exempt("example.com:6443", "example.com", 443));
        assert!(exempt("example.com:6443", "example.com", 6443));
        assert!(exempt("10.1.2.3", "10.1.2.3", 6443));
        assert!(exempt("10.0.0.0/8", "10.1.2.3", 6443));
        assert!(!exempt("10.0.0.0/8", "11.0.0.1", 6443));
        assert!(exempt("fd00::/8", "fd12::1", 6443));
        assert!(exempt("[fd12::1]:6443", "fd12::1", 6443));
        assert!(!exempt("10.0.0.0/99", "10.0.0.1", 1));
    }

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    #[test]
    fn the_environment_proxy_skips_exempt_and_loopback_servers() {
        let env = vars(&[
            ("HTTPS_PROXY", "http://corp:3128"),
            ("NO_PROXY", ".internal,localhost,127.0.0.1"),
        ]);
        assert_eq!(
            env_proxy("https://api.example.com", &env),
            Some("http://corp:3128".into())
        );
        assert_eq!(env_proxy("https://k8s.internal:6443", &env), None);
        assert_eq!(env_proxy("https://[::1]:6443", &env), None);
        assert_eq!(env_proxy("https://localhost:6443", &env), None);
        let lower = vars(&[
            ("https_proxy", "http://corp:3128"),
            ("no_proxy", "example.com"),
        ]);
        assert_eq!(env_proxy("https://api.example.com", &lower), None);
        assert_eq!(
            env_proxy("https://other.org", &lower),
            Some("http://corp:3128".into())
        );
        assert_eq!(
            env_proxy("https://other.org", vars(&[("HTTPS_PROXY", " ")])),
            None
        );
        assert_eq!(env_proxy("https://other.org", vars(&[])), None);
    }
}
