//! What the saved kubeconfigs share: the cluster's own entry made portable, a checked
//! destination, and a private write whose errors never quote the path.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::ops::invalid;
use crate::app_core::AppCore;
use crate::cluster::ProxyOrigin;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{write_private, ClusterId};

/// The first cluster entry of a cluster's own kubeconfig, ready for a new file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SourceCluster {
    pub(crate) name: String,
    pub(crate) cluster: Value,
}

/// The fields of a cluster entry that a saved kubeconfig keeps.
const KEPT_FIELDS: [&str; 5] = [
    "server",
    "certificate-authority-data",
    "insecure-skip-tls-verify",
    "proxy-url",
    "tls-server-name",
];

/// The cluster entry for the new file. A CA file becomes data, because the path means nothing
/// wherever the file ends up.
pub(crate) fn portable_cluster(
    cluster: &Value,
    read_ca: impl Fn(&str) -> std::io::Result<Vec<u8>>,
) -> CoreResult<Value> {
    let mut kept = serde_json::Map::new();
    for field in KEPT_FIELDS {
        if let Some(value) = cluster.get(field) {
            kept.insert(field.to_owned(), value.clone());
        }
    }
    if !kept.contains_key("certificate-authority-data") {
        if let Some(path) = cluster.get("certificate-authority").and_then(Value::as_str) {
            let bytes = read_ca(path).map_err(|_| {
                IpcError::new(ErrorCode::Internal, "the cluster's CA file cannot be read")
            })?;
            kept.insert(
                "certificate-authority-data".to_owned(),
                json!(STANDARD.encode(bytes)),
            );
        }
    }
    Ok(Value::Object(kept))
}

pub(crate) fn check_destination(dest: &Path) -> CoreResult<()> {
    if !dest.is_absolute() {
        return Err(invalid("the destination path must be absolute"));
    }
    if !dest.parent().is_some_and(Path::is_dir) {
        return Err(invalid("the destination folder does not exist"));
    }
    Ok(())
}

fn source_cluster_from(
    text: &[u8],
    read_ca: impl Fn(&str) -> std::io::Result<Vec<u8>>,
) -> CoreResult<SourceCluster> {
    let source: Value = serde_yaml_ng::from_slice(text).map_err(|_| {
        IpcError::new(
            ErrorCode::Internal,
            "the cluster's kubeconfig cannot be read",
        )
    })?;
    let no_cluster = || {
        IpcError::new(
            ErrorCode::Internal,
            "the cluster's kubeconfig has no cluster",
        )
    };
    let entry = source.pointer("/clusters/0").ok_or_else(no_cluster)?;
    let cluster = entry.get("cluster").ok_or_else(no_cluster)?;
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("cluster")
        .to_owned();
    Ok(SourceCluster {
        name,
        cluster: portable_cluster(cluster, read_ca)?,
    })
}

/// Reads the cluster entry of the kubeconfig at `path`, the cluster's own.
pub(crate) fn source_cluster(path: &Path) -> CoreResult<SourceCluster> {
    source_cluster_from(&std::fs::read(path)?, |ca| std::fs::read(ca))
}

/// Writes `text` to `dest`, mode 0600 on Unix.
pub(crate) fn write_kubeconfig(dest: &Path, text: &str) -> CoreResult<()> {
    write_private(dest, text.as_bytes()).map_err(|error| {
        // The io error quotes the destination path, which must not reach the caller.
        IpcError::new(
            error.code,
            "the kubeconfig cannot be written to the destination",
        )
    })
}

/// A kubeconfig that signs in as `user` with a client certificate (spec §5.1.1). serde's
/// own copies of the key are freed without wiping; the returned text is wiped.
pub(crate) fn client_cert_kubeconfig(
    source: &SourceCluster,
    user: &str,
    certificate_pem: &str,
    key_pem: &str,
    namespace: Option<&str>,
) -> CoreResult<Zeroizing<String>> {
    let label = format!("{user}@{}", source.name);
    let mut context = json!({ "cluster": source.name, "user": label });
    if let Some(namespace) = namespace {
        context["namespace"] = json!(namespace);
    }
    let key_data = Zeroizing::new(STANDARD.encode(key_pem.as_bytes()));
    let document = json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{ "name": source.name, "cluster": source.cluster }],
        "users": [{
            "name": label,
            "user": {
                "client-certificate-data": STANDARD.encode(certificate_pem.as_bytes()),
                "client-key-data": key_data.as_str(),
            },
        }],
        "contexts": [{ "name": label, "context": context }],
        "current-context": label,
    });
    serde_yaml_ng::to_string(&document)
        .map(Zeroizing::new)
        .map_err(|_| IpcError::new(ErrorCode::Internal, "the kubeconfig cannot be written"))
}

/// Puts back the source's own `proxy-url` where `{id}.yaml` holds a tunnel's gateway URL, so
/// an export never carries this run's token (tunnels spec §5.7).
pub(crate) fn restore_proxy_url(cluster: &mut Value, origin: &ProxyOrigin) {
    let (ProxyOrigin::Tunnel { source_proxy_url }, Value::Object(map)) = (origin, cluster) else {
        return;
    };
    match source_proxy_url {
        Some(url) => {
            map.insert("proxy-url".to_owned(), Value::String(url.clone()));
        }
        None => {
            map.remove("proxy-url");
        }
    }
}

impl AppCore {
    /// The connected cluster's entry for an export, with the source's own `proxy-url`.
    pub(crate) fn cluster_export_source(&self, id: &ClusterId) -> CoreResult<SourceCluster> {
        let mut source = source_cluster(&self.cluster_kubeconfig_path(id)?)?;
        restore_proxy_url(&mut source.cluster, &self.connections().proxy_origin(id)?);
        Ok(source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_connection_fields_are_kept() {
        let cluster = json!({
            "server": "https://s",
            "proxy-url": "http://p",
            "tls-server-name": "n",
            "insecure-skip-tls-verify": true,
            "extensions": [{ "name": "x" }],
        });
        let kept = portable_cluster(&cluster, |_| unreachable!()).unwrap();
        assert_eq!(
            kept,
            json!({
                "server": "https://s",
                "proxy-url": "http://p",
                "tls-server-name": "n",
                "insecure-skip-tls-verify": true,
            })
        );
    }

    #[test]
    fn a_ca_file_becomes_data_and_data_stays_as_it_is() {
        let from_file = json!({ "server": "s", "certificate-authority": "/ca.crt" });
        let kept = portable_cluster(&from_file, |path| {
            assert_eq!(path, "/ca.crt");
            Ok(b"ca".to_vec())
        })
        .unwrap();
        assert_eq!(kept["certificate-authority-data"], STANDARD.encode(b"ca"));
        assert!(kept.get("certificate-authority").is_none());

        let with_data = json!({ "server": "s", "certificate-authority-data": "abc" });
        let kept = portable_cluster(&with_data, |_| unreachable!()).unwrap();
        assert_eq!(kept["certificate-authority-data"], "abc");
    }

    #[test]
    fn a_ca_file_that_cannot_be_read_does_not_quote_its_path() {
        let cluster = json!({ "server": "s", "certificate-authority": "/secret/ca.crt" });
        let error = portable_cluster(&cluster, |_| Err(std::io::Error::other("nope"))).unwrap_err();
        assert!(!error.message.contains("secret"), "{}", error.message);
    }

    const SOURCE: &str = "
clusters:
- name: kind-skopos
  cluster:
    server: https://127.0.0.1:6443
    certificate-authority-data: Y2E=
";

    #[test]
    fn the_source_cluster_keeps_its_name_and_portable_fields() {
        let source = source_cluster_from(SOURCE.as_bytes(), |_| unreachable!()).unwrap();
        assert_eq!(source.name, "kind-skopos");
        assert_eq!(source.cluster["server"], "https://127.0.0.1:6443");
        let nameless =
            source_cluster_from(b"clusters: [{cluster: {server: s}}]", |_| unreachable!()).unwrap();
        assert_eq!(nameless.name, "cluster");
        let error = source_cluster_from(b"clusters: []", |_| unreachable!()).unwrap_err();
        assert_eq!(error.message, "the cluster's kubeconfig has no cluster");
    }

    fn parsed(text: &str) -> Value {
        serde_yaml_ng::from_str(text).unwrap()
    }

    #[test]
    fn a_client_certificate_kubeconfig_holds_the_certificate_and_the_key() {
        let source = source_cluster_from(SOURCE.as_bytes(), |_| unreachable!()).unwrap();
        let text = client_cert_kubeconfig(&source, "carol", "CERT PEM", "KEY PEM", None).unwrap();
        let doc = parsed(&text);
        assert_eq!(doc["current-context"], "carol@kind-skopos");
        assert_eq!(doc["clusters"][0]["name"], "kind-skopos");
        assert_eq!(
            doc["clusters"][0]["cluster"]["server"],
            "https://127.0.0.1:6443"
        );
        let user = &doc["users"][0];
        assert_eq!(user["name"], "carol@kind-skopos");
        assert_eq!(
            user["user"]["client-certificate-data"],
            STANDARD.encode("CERT PEM")
        );
        assert_eq!(user["user"]["client-key-data"], STANDARD.encode("KEY PEM"));
        let context = &doc["contexts"][0];
        assert_eq!(context["name"], "carol@kind-skopos");
        assert_eq!(context["context"]["cluster"], "kind-skopos");
        assert_eq!(context["context"]["user"], "carol@kind-skopos");
        assert!(context["context"].get("namespace").is_none());
    }

    #[test]
    fn a_grant_namespace_becomes_the_context_namespace() {
        let source = source_cluster_from(SOURCE.as_bytes(), |_| unreachable!()).unwrap();
        let text = client_cert_kubeconfig(&source, "carol", "C", "K", Some("payments")).unwrap();
        assert_eq!(
            parsed(&text)["contexts"][0]["context"]["namespace"],
            "payments"
        );
    }

    #[test]
    fn a_failed_write_does_not_quote_the_path() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should go: the write fails.
        let dest = dir.path().join("secret-name");
        std::fs::create_dir(&dest).unwrap();
        let error = write_kubeconfig(&dest, "x").unwrap_err();
        assert!(!error.message.contains("secret-name"), "{}", error.message);
    }
    #[test]
    fn a_relative_or_homeless_destination_is_refused() {
        assert!(check_destination(Path::new("config")).is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(check_destination(&dir.path().join("missing").join("config")).is_err());
        assert!(check_destination(&dir.path().join("config")).is_ok());
    }
}

#[cfg(test)]
mod restore_tests {
    use super::*;

    #[test]
    fn the_source_proxy_url_replaces_the_gateway_or_none_removes_it() {
        let mut cluster = json!({ "server": "https://a", "proxy-url": "http://t:tok@127.0.0.1:1" });
        let origin = ProxyOrigin::Tunnel {
            source_proxy_url: Some("http://corp:3128".into()),
        };
        restore_proxy_url(&mut cluster, &origin);
        assert_eq!(cluster["proxy-url"], "http://corp:3128");
        restore_proxy_url(
            &mut cluster,
            &ProxyOrigin::Tunnel {
                source_proxy_url: None,
            },
        );
        assert!(cluster.get("proxy-url").is_none());
        let mut own = json!({ "proxy-url": "http://own:1" });
        restore_proxy_url(&mut own, &ProxyOrigin::Source);
        assert_eq!(own["proxy-url"], "http://own:1");
    }
}
