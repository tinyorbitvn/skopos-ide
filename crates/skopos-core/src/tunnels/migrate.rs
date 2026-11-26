//! Moves the old `proxyUrl` cluster setting into proxy tunnels (tunnels spec §5.4). It runs on
//! every start and does nothing once no cluster has a `proxy_url`. It never logs a URL, which
//! may hold a password.

use std::collections::HashMap;

use url::Url;

use super::model::{proxy_url, TunnelDef, TunnelKind, NAME_MAX};
use super::secrets::proxy_password_account;
use super::store::TUNNELS_FILE;
use crate::agents::endpoint::new_token;
use crate::app_core::{AppCore, CLUSTERS_FILE};
use crate::kubeconfig::ClusterId;
use crate::prefs::ClusterSettings;
use crate::secrets::Secret;
use crate::store::StoreWarning;

/// What one start's migration changes, worked out before anything is written.
#[derive(Debug, Default)]
pub(crate) struct Migration {
    /// The whole tunnels list afterwards.
    pub(crate) tunnels: Vec<TunnelDef>,
    /// The passwords the URLs held: tunnel id, tunnel name, password.
    pub(crate) passwords: Vec<(String, String, Secret)>,
    /// Each cluster that had a URL, by id, and its tunnel; `None` for a URL that is not a
    /// proxy URL.
    pub(crate) clusters: Vec<(ClusterId, Option<String>)>,
}

/// `%XX` decoded; a broken escape stays as written.
fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let escaped = bytes
            .get(at + 1..at + 3)
            .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[at], escaped) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A legacy URL as a tunnel kind, its `host:port` name, and the password it held.
fn split_legacy(text: &str) -> Option<(TunnelKind, String, Option<Secret>)> {
    let parsed = Url::parse(text.trim()).ok()?;
    if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some()
    {
        return None;
    }
    let host = parsed.host_str().filter(|host| !host.is_empty())?;
    let scheme = parsed.scheme();
    let base = match parsed.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    };
    let url = proxy_url(&base).ok()?;
    let port = parsed
        .port_or_known_default()
        .or((scheme == "socks5").then_some(1080))?;
    let username = Some(percent_decoded(parsed.username())).filter(|user| !user.is_empty());
    let kind = TunnelKind::Proxy { url, username }.normalized().ok()?;
    let password = parsed
        .password()
        .map(percent_decoded)
        .filter(|password| !password.is_empty())
        .map(Secret::new);
    let name: String = format!("{host}:{port}")
        .chars()
        .take(NAME_MAX - 6)
        .collect();
    Some((kind, name, password))
}

/// `label`, or `label (2)`, `label (3)`, … when a tunnel has that name, ignoring case.
fn unique_name(label: &str, tunnels: &[TunnelDef]) -> String {
    let taken = |name: &str| tunnels.iter().any(|t| t.name.eq_ignore_ascii_case(name));
    if !taken(label) {
        return label.to_owned();
    }
    (2..)
        .map(|n| format!("{label} ({n})"))
        .find(|name| !taken(name))
        .unwrap_or_else(|| label.to_owned())
}

/// The migration of every cluster's `proxy_url`, by cluster id. `None` when no cluster has one.
pub(crate) fn plan(
    existing: &[TunnelDef],
    clusters: &HashMap<ClusterId, ClusterSettings>,
) -> Option<Migration> {
    let mut legacy: Vec<(&ClusterId, &str)> = clusters
        .iter()
        .filter_map(|(id, settings)| {
            let url = settings.proxy_url.as_deref().map(str::trim)?;
            (!url.is_empty()).then_some((id, url))
        })
        .collect();
    if legacy.is_empty() {
        return None;
    }
    legacy.sort();
    let mut migration = Migration {
        tunnels: existing.to_vec(),
        ..Default::default()
    };
    for (cluster, text) in legacy {
        let Some((kind, label, password)) = split_legacy(text) else {
            migration.clusters.push((cluster.clone(), None));
            continue;
        };
        let (id, name) = match migration.tunnels.iter().find(|t| t.kind == kind) {
            Some(found) => (found.id.clone(), found.name.clone()),
            None => {
                let def = TunnelDef {
                    id: new_token(),
                    name: unique_name(&label, &migration.tunnels),
                    kind,
                    remembered: Vec::new(),
                };
                let found = (def.id.clone(), def.name.clone());
                migration.tunnels.push(def);
                found
            }
        };
        if let Some(password) = password {
            if !migration
                .passwords
                .iter()
                .any(|(tunnel, _, _)| tunnel == &id)
            {
                migration.passwords.push((id.clone(), name, password));
            }
        }
        migration.clusters.push((cluster.clone(), Some(id)));
    }
    Some(migration)
}

impl AppCore {
    /// Runs the migration before any cluster connects, in the order of spec §5.4, and returns
    /// the warnings for the windows. Blocks on the keychain when a URL held a password.
    pub(crate) fn migrate_proxy_urls(&self) -> Vec<StoreWarning> {
        let settings = self.cluster_settings_store().get();
        let Some(migration) = plan(&self.tunnels_store().get(), &settings) else {
            return Vec::new();
        };
        let mut warnings = Vec::new();
        let tunnels = migration.tunnels.clone();
        if let Err(e) = self.tunnels_store().update(|all| *all = tunnels) {
            warnings.push(StoreWarning {
                file: TUNNELS_FILE.to_owned(),
                message: format!(
                    "The proxy URL settings could not be moved into tunnels: {}",
                    e.message
                ),
            });
            return warnings;
        }
        for (id, name, password) in migration.passwords {
            let account = proxy_password_account(&id);
            match self.tunnel_secrets().set(&account, password) {
                Ok(()) => {
                    let remembered = self.tunnels_store().update(|all| {
                        if let Some(tunnel) = all.iter_mut().find(|t| t.id == id) {
                            if !tunnel.remembered.contains(&account) {
                                tunnel.remembered.push(account.clone());
                            }
                        }
                    });
                    if let Err(e) = remembered {
                        tracing::warn!("tunnels.json: {}", e.message);
                    }
                }
                Err(reason) => warnings.push(StoreWarning {
                    file: TUNNELS_FILE.to_owned(),
                    message: format!(
                        "The password of proxy tunnel \"{name}\" could not be saved in the keychain \
                         ({reason}); enter it again after a restart"
                    ),
                }),
            }
        }
        let entries = self.context_entries();
        for (cluster, tunnel) in &migration.clusters {
            if tunnel.is_some() {
                continue;
            }
            let name = settings
                .get(cluster)
                .and_then(|s| s.display_name.clone())
                .or_else(|| {
                    entries
                        .iter()
                        .find(|e| &e.id == cluster)
                        .map(|e| e.context_name.clone())
                })
                .unwrap_or_else(|| cluster.clone());
            warnings.push(StoreWarning {
                file: CLUSTERS_FILE.to_owned(),
                message: format!(
                    "The proxy URL of cluster \"{name}\" is not a proxy URL and was removed; \
                     pick a tunnel in its settings"
                ),
            });
        }
        let moved = self.cluster_settings_store().update(|all| {
            for (cluster, tunnel) in &migration.clusters {
                if let Some(settings) = all.get_mut(cluster) {
                    settings.proxy_url = None;
                    settings.tunnel = tunnel.clone();
                }
            }
        });
        if let Err(e) = moved {
            warnings.push(StoreWarning {
                file: CLUSTERS_FILE.to_owned(),
                message: format!(
                    "The clusters could not be moved onto their tunnels: {}",
                    e.message
                ),
            });
        }
        warnings
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy(pairs: &[(&str, &str)]) -> HashMap<ClusterId, ClusterSettings> {
        pairs
            .iter()
            .map(|(id, url)| {
                let settings = ClusterSettings {
                    proxy_url: Some((*url).to_owned()),
                    ..Default::default()
                };
                ((*id).to_owned(), settings)
            })
            .collect()
    }

    #[test]
    fn nothing_to_do_without_a_proxy_url() {
        let mut clusters = legacy(&[("a", "  ")]);
        clusters.insert("b".into(), ClusterSettings::default());
        assert!(plan(&[], &clusters).is_none());
    }

    #[test]
    fn one_url_on_two_clusters_becomes_one_tunnel_with_the_password_apart() {
        let clusters = legacy(&[
            ("a", "http://me:p%40ss@proxy.corp:3128"),
            ("b", " http://me:p%40ss@proxy.corp:3128/ "),
        ]);
        let migration = plan(&[], &clusters).unwrap();
        assert_eq!(migration.tunnels.len(), 1);
        let tunnel = &migration.tunnels[0];
        assert_eq!(tunnel.name, "proxy.corp:3128");
        assert_eq!(
            tunnel.kind,
            TunnelKind::Proxy {
                url: "http://proxy.corp:3128".into(),
                username: Some("me".into())
            }
        );
        assert_eq!(migration.passwords.len(), 1);
        assert_eq!(migration.passwords[0].2, Secret::new("p@ss"));
        assert_eq!(
            migration.clusters,
            [
                ("a".to_owned(), Some(tunnel.id.clone())),
                ("b".to_owned(), Some(tunnel.id.clone()))
            ]
        );
    }

    #[test]
    fn an_existing_tunnel_with_the_same_url_and_user_is_reused() {
        let existing = TunnelDef {
            id: "t1".into(),
            name: "corp".into(),
            kind: TunnelKind::Proxy {
                url: "socks5://10.0.0.5:1080".into(),
                username: None,
            },
            remembered: Vec::new(),
        };
        let migration = plan(&[existing], &legacy(&[("a", "socks5://10.0.0.5:1080")])).unwrap();
        assert_eq!(migration.tunnels.len(), 1);
        assert_eq!(
            migration.clusters,
            [("a".to_owned(), Some("t1".to_owned()))]
        );
    }

    #[test]
    fn a_name_in_use_gets_a_number_and_a_bad_url_gets_no_tunnel() {
        let existing = TunnelDef {
            id: "t1".into(),
            name: "p:3128".into(),
            kind: TunnelKind::Proxy {
                url: "https://p:3128".into(),
                username: None,
            },
            remembered: Vec::new(),
        };
        let clusters = legacy(&[
            ("a", "http://p:3128"),
            ("b", "not a url"),
            ("c", "ftp://p:21"),
        ]);
        let migration = plan(&[existing], &clusters).unwrap();
        assert_eq!(migration.tunnels[1].name, "p:3128 (2)");
        assert_eq!(migration.clusters[1], ("b".to_owned(), None));
        assert_eq!(migration.clusters[2], ("c".to_owned(), None));
        assert!(migration.passwords.is_empty());
    }

    #[test]
    fn a_socks5_url_without_a_port_names_1080() {
        let migration = plan(&[], &legacy(&[("a", "socks5://bastion")])).unwrap();
        assert_eq!(migration.tunnels[0].name, "bastion:1080");
    }
}
