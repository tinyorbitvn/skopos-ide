//! Metrics (F16): the provider setting, detection of Prometheus or metrics-server with a cache
//! per cluster, and the queries the interface repeats on its own timer (spec §5.4).

mod detect;
mod disk;
pub(crate) mod prometheus;
mod query;
mod remote;
pub(crate) mod templates;
pub(crate) use detect::Metrics;
pub use detect::MetricsLimits;
mod usage;
pub use disk::{NodeDisk, NodeDiskSnapshot};
pub(crate) use usage::{parse_quantity, METRICS_API};
pub use usage::{UsageItem, UsageOf, UsageSnapshot};

use std::collections::BTreeMap;
use std::path::Path;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use url::{Host, Url};

use crate::error::CoreResult;
use crate::resources::invalid;

/// `ClusterSettings.metricsProvider`: detect, pin one Prometheus Service or a
/// Prometheus-compatible URL, use metrics-server alone, or show no metrics.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MetricsProviderSetting {
    #[default]
    Auto,
    Prometheus {
        namespace: String,
        service: String,
        port: u16,
        scheme: Option<PrometheusScheme>,
        /// Where Prometheus serves its API when it runs under a path, such as `/prometheus`.
        path_prefix: Option<String>,
        /// Sent as `X-Scope-OrgID`, for Mimir and other multi-tenant APIs.
        tenant: Option<String>,
        /// A label every query also matches, for a tenant that holds several clusters.
        matcher: Option<LabelMatcher>,
    },
    /// A Prometheus-compatible API reached directly at a URL, such as Mimir or Grafana Cloud.
    Remote {
        /// The API base, such as `https://mimir.example.com/prometheus`.
        url: String,
        tenant: Option<String>,
        matcher: Option<LabelMatcher>,
        auth: RemoteAuth,
        /// A PEM file of CAs trusted beside the system's.
        ca_path: Option<String>,
    },
    MetricsServer,
    /// `none` on the wire. A variant named `None` would read as `Option::None` in patterns.
    #[serde(rename = "none")]
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum PrometheusScheme {
    Http,
    Https,
}

/// How a `remote` setting proves who it is. The Basic password and the Bearer token are kept
/// in the keychain, never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum RemoteAuth {
    /// `none` on the wire, named like [`MetricsProviderSetting::Off`] for the same reason.
    #[serde(rename = "none")]
    Anonymous,
    Basic {
        username: String,
    },
    Bearer,
    /// A client certificate and its key, as PEM files.
    Mtls {
        cert_path: String,
        key_path: String,
    },
}

/// `name="value"`: a label every query also matches, such as `cluster="prod"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LabelMatcher {
    pub name: String,
    pub value: String,
}

const PATH_PREFIX_ERROR: &str = "The path prefix must be a path such as /prometheus.";
const TENANT_ERROR: &str =
    "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters.";
const LABEL_NAME_ERROR: &str = "A label name is letters, digits and _, and does not start with __.";
const LABEL_PAIR_ERROR: &str = "A cluster label needs a name and a value.";
const LABEL_VALUE_ERROR: &str = "A label value is at most 1024 characters.";
const URL_ERROR: &str =
    "The URL must be http:// or https:// with a host, without a user name, query or fragment.";
const PLAIN_HTTP_ERROR: &str = "Basic and Bearer credentials need https://, except to localhost.";
const MTLS_HTTP_ERROR: &str = "A client certificate needs https://.";
const USERNAME_ERROR: &str = "The user name must not be empty or contain ':'.";
/// Mimir's longest tenant ID.
const TENANT_MAX: usize = 150;
const LABEL_VALUE_MAX: usize = 1024;

impl MetricsProviderSetting {
    /// The setting as it is saved. A pinned Service has its names checked, its path prefix
    /// trimmed to `/a/b` form or `None`, its tenant and cluster label checked (spec I2, I3).
    /// A URL is checked with its authentication, and its PEM files are read (spec I32 to I35).
    /// Anything else is `InvalidInput`.
    pub(crate) fn normalized(self) -> CoreResult<Self> {
        let Self::Prometheus {
            namespace,
            service,
            port,
            scheme,
            path_prefix,
            tenant,
            matcher,
        } = self
        else {
            return remote_of(self);
        };
        let namespace = namespace.trim().to_owned();
        let service = service.trim().to_owned();
        if !is_dns_label(&namespace) {
            return Err(invalid(
                "the Prometheus namespace must be a lowercase RFC 1123 label",
            ));
        }
        if !is_dns_label(&service) {
            return Err(invalid(
                "the Prometheus service must be a lowercase RFC 1123 label",
            ));
        }
        if port == 0 {
            return Err(invalid("the Prometheus port must be between 1 and 65535"));
        }
        Ok(Self::Prometheus {
            namespace,
            service,
            port,
            scheme,
            path_prefix: path_prefix_of(path_prefix)?,
            tenant: tenant_of(tenant)?,
            matcher: matcher_of(matcher)?,
        })
    }

    /// Whether the setting sends a password or token, which the keychain keeps (spec I50).
    pub(crate) fn needs_secret(&self) -> bool {
        matches!(
            self,
            Self::Remote {
                auth: RemoteAuth::Basic { .. } | RemoteAuth::Bearer,
                ..
            }
        )
    }
}

/// A `remote` setting as it is saved (spec I32 to I35); any other setting as it is.
fn remote_of(setting: MetricsProviderSetting) -> CoreResult<MetricsProviderSetting> {
    let MetricsProviderSetting::Remote {
        url,
        tenant,
        matcher,
        auth,
        ca_path,
    } = setting
    else {
        return Ok(setting);
    };
    let (url, parsed) = remote_url_of(&url)?;
    Ok(MetricsProviderSetting::Remote {
        url,
        tenant: tenant_of(tenant)?,
        matcher: matcher_of(matcher)?,
        auth: auth_of(auth, &parsed)?,
        ca_path: ca_path_of(ca_path)?,
    })
}

/// The URL trimmed and without trailing `/`, and parsed: `http` or `https` with a host, and
/// no user info, query or fragment, so no credential is ever saved in it (spec I32).
pub(crate) fn remote_url_of(url: &str) -> CoreResult<(String, Url)> {
    let url = url.trim().trim_end_matches('/');
    Url::parse(url)
        .ok()
        .filter(|parsed| {
            matches!(parsed.scheme(), "http" | "https")
                && parsed.host().is_some()
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.query().is_none()
                && parsed.fragment().is_none()
        })
        .map(|parsed| (url.to_owned(), parsed))
        .ok_or_else(|| invalid(URL_ERROR))
}

/// Basic and Bearer over `https`, or plain `http` to this machine; a client certificate only
/// over `https` (spec I33). The user name is trimmed and holds no `:` (I34), and the
/// certificate and key files are read (I35).
fn auth_of(auth: RemoteAuth, url: &Url) -> CoreResult<RemoteAuth> {
    let https = url.scheme() == "https";
    match auth {
        RemoteAuth::Anonymous => Ok(RemoteAuth::Anonymous),
        RemoteAuth::Basic { .. } | RemoteAuth::Bearer if !https && !is_loopback(url) => {
            Err(invalid(PLAIN_HTTP_ERROR))
        }
        RemoteAuth::Basic { username } => {
            let username = username.trim();
            if username.is_empty() || username.contains(':') {
                return Err(invalid(USERNAME_ERROR));
            }
            Ok(RemoteAuth::Basic {
                username: username.to_owned(),
            })
        }
        RemoteAuth::Bearer => Ok(RemoteAuth::Bearer),
        RemoteAuth::Mtls { .. } if !https => Err(invalid(MTLS_HTTP_ERROR)),
        RemoteAuth::Mtls {
            cert_path,
            key_path,
        } => Ok(RemoteAuth::Mtls {
            cert_path: pem_file_of(&cert_path, PemFile::Certificate)?,
            key_path: pem_file_of(&key_path, PemFile::Key)?,
        }),
    }
}

/// `localhost`, an address in `127.0.0.0/8`, or `::1`.
pub(crate) fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost",
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

/// An empty CA path is no CA file.
fn ca_path_of(path: Option<String>) -> CoreResult<Option<String>> {
    match path.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(path) => pem_file_of(path, PemFile::Ca).map(Some),
    }
}

/// The PEM files a `remote` setting names.
#[derive(Debug, Clone, Copy)]
pub(crate) enum PemFile {
    Ca,
    Certificate,
    Key,
}

impl PemFile {
    /// The setting's field, which a refusal carries as its details so the page can show it
    /// under that field.
    fn field(self) -> &'static str {
        match self {
            Self::Ca => "caPath",
            Self::Certificate => "certPath",
            Self::Key => "keyPath",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Self::Ca => "The CA file",
            Self::Certificate => "The certificate file",
            Self::Key => "The key file",
        }
    }
}

/// The path trimmed, once its file was read and holds what `kind` needs (spec I35).
fn pem_file_of(path: &str, kind: PemFile) -> CoreResult<String> {
    let path = path.trim();
    read_pem_file(path, kind)?;
    Ok(path.to_owned())
}

/// The file at the absolute `path`, when it holds what `kind` needs (spec I35): a
/// certificate, or one unencrypted PKCS#8, RSA or SEC1 EC key. The refusal's details name
/// the setting's field.
pub(crate) fn read_pem_file(path: &str, kind: PemFile) -> CoreResult<Vec<u8>> {
    let refused = |message: String| invalid(message).with_details(kind.field());
    if !Path::new(path).is_absolute() {
        return Err(refused(format!(
            "{} must be an absolute path.",
            kind.noun()
        )));
    }
    let pem =
        std::fs::read(path).map_err(|e| refused(format!("{path} could not be read: {e}.")))?;
    let usable = match kind {
        PemFile::Ca | PemFile::Certificate => holds_certificates(&pem),
        PemFile::Key => PrivateKeyDer::from_pem_slice(&pem).is_ok(),
    };
    if !usable {
        return Err(refused(match kind {
            PemFile::Ca | PemFile::Certificate => format!("{path} holds no PEM certificate."),
            PemFile::Key => {
                format!("{path} holds no unencrypted PEM private key (PKCS#8, RSA or EC).")
            }
        }));
    }
    Ok(pem)
}

/// Whether a PEM file holds a certificate, and every certificate block in it can be read.
fn holds_certificates(pem: &[u8]) -> bool {
    CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .is_ok_and(|certificates| !certificates.is_empty())
}

/// Lowercase letters, digits and `-`, 1 to 63 characters, with a letter or digit at each
/// end: what Kubernetes allows for namespace and Service names.
fn is_dns_label(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn path_prefix_of(prefix: Option<String>) -> CoreResult<Option<String>> {
    let Some(prefix) = prefix else {
        return Ok(None);
    };
    let prefix = prefix.trim().trim_end_matches('/');
    if prefix.is_empty() {
        return Ok(None);
    }
    // Only characters that need no escaping in a URL path, so the request always builds.
    let unusable = !prefix.starts_with('/')
        || !prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~/".contains(c))
        || prefix
            .split('/')
            .any(|segment| segment == "." || segment == "..");
    if unusable {
        return Err(invalid(PATH_PREFIX_ERROR));
    }
    Ok(Some(prefix.to_owned()))
}

/// Mimir's tenant ID rules (spec I2): trimmed, `None` when empty, else 1 to 150 ASCII
/// letters, digits and `! - _ . * ' ( )`, and not `.`, `..` or `__mimir_cluster`.
fn tenant_of(tenant: Option<String>) -> CoreResult<Option<String>> {
    let Some(tenant) = tenant else {
        return Ok(None);
    };
    let tenant = tenant.trim();
    if tenant.is_empty() {
        return Ok(None);
    }
    // Only ASCII passes, so bytes are characters.
    let usable = tenant.len() <= TENANT_MAX
        && tenant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!-_.*'()".contains(&b))
        && !matches!(tenant, "." | ".." | "__mimir_cluster");
    if !usable {
        return Err(invalid(TENANT_ERROR));
    }
    Ok(Some(tenant.to_owned()))
}

/// The cluster label (spec I3): the name trimmed, the value as typed; `None` when both are
/// empty.
fn matcher_of(matcher: Option<LabelMatcher>) -> CoreResult<Option<LabelMatcher>> {
    let Some(LabelMatcher { name, value }) = matcher else {
        return Ok(None);
    };
    let name = name.trim().to_owned();
    if name.is_empty() && value.is_empty() {
        return Ok(None);
    }
    if name.is_empty() || value.is_empty() {
        return Err(invalid(LABEL_PAIR_ERROR));
    }
    if !is_label_name(&name) {
        return Err(invalid(LABEL_NAME_ERROR));
    }
    if value.chars().count() > LABEL_VALUE_MAX {
        return Err(invalid(LABEL_VALUE_ERROR));
    }
    Ok(Some(LabelMatcher { name, value }))
}

/// `[a-zA-Z_][a-zA-Z0-9_]*`, without the `__` prefix Prometheus reserves.
fn is_label_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !name.starts_with("__")
}

/// What `metrics_query` reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MetricsTarget {
    Cluster,
    /// The API server's own metrics, and etcd as the API server sees it.
    ControlPlane,
    Node {
        name: String,
    },
    Pod {
        namespace: String,
        name: String,
    },
    Workload {
        namespace: String,
        name: String,
        workload_kind: WorkloadKind,
    },
    Pvc {
        namespace: String,
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum WorkloadKind {
    Deployment,
    StatefulSet,
    DaemonSet,
    ReplicaSet,
    Job,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum MetricsRange {
    #[serde(rename = "1h")]
    OneHour,
    #[serde(rename = "6h")]
    SixHours,
    #[serde(rename = "24h")]
    OneDay,
    #[serde(rename = "7d")]
    SevenDays,
}

/// Units: CPU in cores; memory and disk in bytes; network and filesystem reads and writes in
/// bytes per second; pods as counts; API requests and errors in requests per second; latency in
/// seconds; the etcd database in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetricName {
    CpuUsage,
    CpuRequests,
    CpuLimits,
    CpuAllocatable,
    CpuCapacity,
    MemoryUsage,
    MemoryRequests,
    MemoryLimits,
    MemoryAllocatable,
    MemoryCapacity,
    PodUsage,
    PodAllocatable,
    PodCapacity,
    DiskUsage,
    DiskCapacity,
    NetworkReceive,
    NetworkTransmit,
    FsReads,
    FsWrites,
    FsUsage,
    ApiRequests,
    ApiErrors,
    ApiLatencyP99,
    EtcdLatencyP99,
    EtcdDbSize,
}

/// Points are `[unix seconds, value]`.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricsResult {
    /// Unix seconds.
    #[ts(type = "number")]
    pub start: i64,
    #[ts(type = "number")]
    pub end: i64,
    /// Seconds between points.
    #[ts(type = "number")]
    pub step: i64,
    pub series: BTreeMap<MetricName, Vec<(f64, f64)>>,
    /// Asked for this target, and answered with no samples.
    pub missing: Vec<MetricName>,
    /// Asked for this target, and the query failed. A metric is in `missing` or in `failed`,
    /// never in both.
    pub failed: Vec<MetricName>,
}

/// Where this cluster's metrics come from, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MetricsProvider {
    Prometheus {
        namespace: String,
        service: String,
        port: u16,
        /// As the Endpoint has them; `null` for a detected Prometheus.
        scheme: Option<PrometheusScheme>,
        path_prefix: Option<String>,
        tenant: Option<String>,
        matcher: Option<LabelMatcher>,
        chosen_by: PrometheusChoice,
    },
    /// A URL reached directly (spec I52). Its path, user name and secret are never shown.
    Remote {
        /// The URL's host, with `:port` when the URL names one.
        host: String,
        tenant: Option<String>,
        matcher: Option<LabelMatcher>,
        chosen_by: RemoteChoice,
    },
    MetricsServer {
        chosen_by: MetricsServerChoice,
    },
    #[serde(rename = "none")]
    Off {
        chosen_by: NoProviderChoice,
    },
}

/// The setting, or the detection tier that found Prometheus, in probe order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PrometheusChoice {
    Setting,
    KubePrometheusStack,
    Operator,
    CommunityChart,
    Label,
}

/// A URL is never detected: only the setting names one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteChoice {
    Setting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetricsServerChoice {
    Setting,
    /// Detection found no Prometheus, and the cluster serves metrics.k8s.io.
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NoProviderChoice {
    Setting,
    NothingFound,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::error::ErrorCode;
    use crate::prefs::ClusterSettings;

    use super::*;

    fn pinned(
        namespace: &str,
        service: &str,
        port: u16,
        prefix: Option<&str>,
    ) -> MetricsProviderSetting {
        MetricsProviderSetting::Prometheus {
            namespace: namespace.to_owned(),
            service: service.to_owned(),
            port,
            scheme: None,
            path_prefix: prefix.map(str::to_owned),
            tenant: None,
            matcher: None,
        }
    }

    /// A Mimir gateway pinned with `tenant` and `matcher` as typed.
    fn mimir(tenant: Option<&str>, matcher: Option<(&str, &str)>) -> MetricsProviderSetting {
        MetricsProviderSetting::Prometheus {
            namespace: "mimir".to_owned(),
            service: "mimir-gateway".to_owned(),
            port: 80,
            scheme: None,
            path_prefix: Some("/prometheus".to_owned()),
            tenant: tenant.map(str::to_owned),
            matcher: matcher.map(|(name, value)| LabelMatcher {
                name: name.to_owned(),
                value: value.to_owned(),
            }),
        }
    }

    /// The message of an `InvalidInput` refusal.
    fn refusal(setting: MetricsProviderSetting) -> String {
        let err = setting.normalized().unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        err.message
    }

    #[test]
    fn settings_targets_and_results_use_the_contract_shape() {
        let saved_before: ClusterSettings =
            serde_json::from_value(json!({ "displayName": "prod" })).unwrap();
        assert_eq!(saved_before.metrics_provider, MetricsProviderSetting::Auto);
        assert_eq!(
            serde_json::to_value(pinned("monitoring", "prom", 9090, Some("/prom"))).unwrap(),
            json!({
                "kind": "prometheus",
                "namespace": "monitoring",
                "service": "prom",
                "port": 9090,
                "scheme": null,
                "pathPrefix": "/prom",
                "tenant": null,
                "matcher": null,
            })
        );
        let https: MetricsProviderSetting = serde_json::from_value(json!({
            "kind": "prometheus",
            "namespace": "m",
            "service": "p",
            "port": 443,
            "scheme": "https",
            "pathPrefix": null,
        }))
        .unwrap();
        assert!(matches!(
            https,
            MetricsProviderSetting::Prometheus {
                scheme: Some(PrometheusScheme::Https),
                ..
            }
        ));
        assert_eq!(
            serde_json::to_value(MetricsProviderSetting::MetricsServer).unwrap(),
            json!({ "kind": "metricsServer" })
        );
        assert_eq!(
            serde_json::to_value(MetricsProviderSetting::Off).unwrap(),
            json!({ "kind": "none" })
        );
        let provider = MetricsProvider::Prometheus {
            namespace: "mimir".to_owned(),
            service: "mimir-gateway".to_owned(),
            port: 80,
            scheme: Some(PrometheusScheme::Https),
            path_prefix: Some("/prometheus".to_owned()),
            tenant: Some("team-a".to_owned()),
            matcher: Some(LabelMatcher {
                name: "cluster".to_owned(),
                value: "prod".to_owned(),
            }),
            chosen_by: PrometheusChoice::Setting,
        };
        assert_eq!(
            serde_json::to_value(&provider).unwrap(),
            json!({
                "kind": "prometheus",
                "namespace": "mimir",
                "service": "mimir-gateway",
                "port": 80,
                "scheme": "https",
                "pathPrefix": "/prometheus",
                "tenant": "team-a",
                "matcher": { "name": "cluster", "value": "prod" },
                "chosenBy": "setting",
            })
        );

        let target: MetricsTarget = serde_json::from_value(json!({
            "kind": "workload",
            "namespace": "shop",
            "name": "web",
            "workloadKind": "StatefulSet",
        }))
        .unwrap();
        assert_eq!(
            target,
            MetricsTarget::Workload {
                namespace: "shop".to_owned(),
                name: "web".to_owned(),
                workload_kind: WorkloadKind::StatefulSet,
            }
        );
        let control_plane: MetricsTarget =
            serde_json::from_value(json!({ "kind": "controlPlane" })).unwrap();
        assert_eq!(control_plane, MetricsTarget::ControlPlane);
        assert_eq!(
            serde_json::to_value(MetricsTarget::ControlPlane).unwrap(),
            json!({ "kind": "controlPlane" })
        );
        assert_eq!(
            serde_json::to_value([
                MetricName::ApiRequests,
                MetricName::ApiErrors,
                MetricName::ApiLatencyP99,
                MetricName::EtcdLatencyP99,
                MetricName::EtcdDbSize,
            ])
            .unwrap(),
            json!([
                "apiRequests",
                "apiErrors",
                "apiLatencyP99",
                "etcdLatencyP99",
                "etcdDbSize"
            ])
        );
        let ranges: Vec<MetricsRange> =
            serde_json::from_value(json!(["1h", "6h", "24h", "7d"])).unwrap();
        assert_eq!(
            ranges,
            [
                MetricsRange::OneHour,
                MetricsRange::SixHours,
                MetricsRange::OneDay,
                MetricsRange::SevenDays,
            ]
        );

        let result = MetricsResult {
            start: 0,
            end: 60,
            step: 60,
            series: BTreeMap::from([(MetricName::CpuUsage, vec![(60.0, 0.5)])]),
            missing: vec![MetricName::FsUsage],
            failed: vec![MetricName::FsReads],
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({
                "start": 0,
                "end": 60,
                "step": 60,
                "series": { "cpuUsage": [[60.0, 0.5]] },
                "missing": ["fsUsage"],
                "failed": ["fsReads"],
            })
        );
    }

    #[test]
    fn a_remote_provider_names_only_its_host_tenant_and_label() {
        let provider = MetricsProvider::Remote {
            host: "mimir.example.com:8443".to_owned(),
            tenant: Some("team-a".to_owned()),
            matcher: Some(LabelMatcher {
                name: "cluster".to_owned(),
                value: "prod".to_owned(),
            }),
            chosen_by: RemoteChoice::Setting,
        };
        assert_eq!(
            serde_json::to_value(&provider).unwrap(),
            json!({
                "kind": "remote",
                "host": "mimir.example.com:8443",
                "tenant": "team-a",
                "matcher": { "name": "cluster", "value": "prod" },
                "chosenBy": "setting",
            })
        );
    }

    #[test]
    fn a_pinned_prometheus_is_tidied_or_refused() {
        assert_eq!(
            pinned(" monitoring ", " prom ", 9090, Some(" /prom/ "))
                .normalized()
                .unwrap(),
            pinned("monitoring", "prom", 9090, Some("/prom"))
        );
        assert_eq!(
            pinned("monitoring", "prom", 9090, Some(" / "))
                .normalized()
                .unwrap(),
            pinned("monitoring", "prom", 9090, None)
        );
        assert_eq!(
            MetricsProviderSetting::Off.normalized().unwrap(),
            MetricsProviderSetting::Off
        );
        let long_name = "p".repeat(64);
        let refused = [
            pinned("", "prom", 9090, None),
            pinned("Monitoring", "prom", 9090, None),
            pinned("monitoring", "prom:80", 9090, None),
            pinned("monitoring", "a/b", 9090, None),
            pinned("monitoring", "-prom", 9090, None),
            pinned("monitoring", &long_name, 9090, None),
            pinned("monitoring", "prom", 0, None),
            pinned("monitoring", "prom", 9090, Some("prom")),
            pinned("monitoring", "prom", 9090, Some("/a/../b")),
            pinned("monitoring", "prom", 9090, Some("/a?b=1")),
            pinned("monitoring", "prom", 9090, Some("/a%2fb")),
            pinned("monitoring", "prom", 9090, Some("/a b")),
            pinned("monitoring", "prom", 9090, Some("/é")),
        ];
        for setting in refused {
            let err = setting.clone().normalized().unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{setting:?}");
        }
        assert_eq!(
            refusal(pinned("monitoring", "prom", 9090, Some("prom"))),
            "The path prefix must be a path such as /prometheus."
        );
    }

    #[test]
    fn a_setting_saved_by_0_5_0_loads_with_no_tenant_or_matcher() {
        let old: MetricsProviderSetting = serde_json::from_value(json!({
            "kind": "prometheus",
            "namespace": "m",
            "service": "p",
            "port": 9090,
            "scheme": null,
            "pathPrefix": null,
        }))
        .unwrap();
        assert!(matches!(
            old,
            MetricsProviderSetting::Prometheus {
                tenant: None,
                matcher: None,
                ..
            }
        ));
        assert_eq!(
            serde_json::to_value(mimir(Some("team-a"), Some(("cluster", "prod")))).unwrap(),
            json!({
                "kind": "prometheus",
                "namespace": "mimir",
                "service": "mimir-gateway",
                "port": 80,
                "scheme": null,
                "pathPrefix": "/prometheus",
                "tenant": "team-a",
                "matcher": { "name": "cluster", "value": "prod" },
            })
        );
    }

    #[test]
    fn a_tenant_is_trimmed_and_follows_mimir_rules() {
        let tenant_of = |tenant: &str| match mimir(Some(tenant), None).normalized().unwrap() {
            MetricsProviderSetting::Prometheus { tenant, .. } => tenant,
            other => panic!("{other:?}"),
        };
        assert_eq!(tenant_of(" team-a "), Some("team-a".to_owned()));
        assert_eq!(tenant_of("   "), None);
        assert_eq!(tenant_of(""), None);
        let every_kind = "aZ09!-_.*'()";
        assert_eq!(tenant_of(every_kind), Some(every_kind.to_owned()));
        let longest = "t".repeat(150);
        assert_eq!(tenant_of(&longest), Some(longest.clone()));

        let text =
            "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters.";
        let too_long = "t".repeat(151);
        for bad in [
            "a|b",
            "team a",
            "team/a",
            "é",
            ".",
            " .. ",
            "__mimir_cluster",
            too_long.as_str(),
        ] {
            assert_eq!(refusal(mimir(Some(bad), None)), text, "{bad:?}");
        }
    }

    #[test]
    fn a_cluster_label_needs_a_prometheus_name_and_a_value_up_to_1024_characters() {
        let matcher_of = |name: &str, value: &str| match mimir(None, Some((name, value)))
            .normalized()
            .unwrap()
        {
            MetricsProviderSetting::Prometheus { matcher, .. } => matcher,
            other => panic!("{other:?}"),
        };
        let pair = |name: &str, value: &str| {
            Some(LabelMatcher {
                name: name.to_owned(),
                value: value.to_owned(),
            })
        };
        assert_eq!(matcher_of(" cluster ", "prod"), pair("cluster", "prod"));
        // The value is kept as typed: spaces, quotes and backslashes included.
        assert_eq!(
            matcher_of("cluster", r#" eu "west" \1 "#),
            pair("cluster", r#" eu "west" \1 "#)
        );
        assert_eq!(matcher_of("_x9", "1"), pair("_x9", "1"));
        assert_eq!(matcher_of("  ", ""), None);
        assert_eq!(matcher_of("", ""), None);
        // 1024 characters of four UTF-8 bytes and two UTF-16 units each.
        let longest = "😀".repeat(1024);
        assert_eq!(matcher_of("cluster", &longest), pair("cluster", &longest));

        let name_text = "A label name is letters, digits and _, and does not start with __.";
        for bad in ["9cluster", "clus-ter", "__name__", "__x", "é"] {
            assert_eq!(
                refusal(mimir(None, Some((bad, "prod")))),
                name_text,
                "{bad:?}"
            );
        }
        let pair_text = "A cluster label needs a name and a value.";
        assert_eq!(refusal(mimir(None, Some(("cluster", "")))), pair_text);
        assert_eq!(refusal(mimir(None, Some(("", "prod")))), pair_text);
        assert_eq!(refusal(mimir(None, Some((" ", "prod")))), pair_text);
        let too_long = "v".repeat(1025);
        assert_eq!(
            refusal(mimir(None, Some(("cluster", too_long.as_str())))),
            "A label value is at most 1024 characters."
        );
    }

    /// A URL with no tenant, no label and no CA file.
    fn remote(url: &str, auth: RemoteAuth) -> MetricsProviderSetting {
        MetricsProviderSetting::Remote {
            url: url.to_owned(),
            tenant: None,
            matcher: None,
            auth,
            ca_path: None,
        }
    }

    fn basic(username: &str) -> RemoteAuth {
        RemoteAuth::Basic {
            username: username.to_owned(),
        }
    }

    fn mtls(cert_path: &str, key_path: &str) -> RemoteAuth {
        RemoteAuth::Mtls {
            cert_path: cert_path.to_owned(),
            key_path: key_path.to_owned(),
        }
    }

    /// The setting as saved, or the message and details of its refusal.
    fn saved(setting: MetricsProviderSetting) -> Result<MetricsProviderSetting, String> {
        setting.normalized().map_err(|err| {
            assert_eq!(err.code, ErrorCode::InvalidInput);
            match err.details {
                Some(details) => format!("{} [{details}]", err.message),
                None => err.message,
            }
        })
    }

    /// A PEM block labelled `label`. The save reads PEM, not what the block holds.
    fn pem(label: &str) -> String {
        format!("-----BEGIN {label}-----\nAAAA\n-----END {label}-----\n")
    }

    #[test]
    fn a_remote_setting_uses_the_contract_shape() {
        let setting = MetricsProviderSetting::Remote {
            url: "https://mimir.example.com/prometheus".to_owned(),
            tenant: Some("team-a".to_owned()),
            matcher: Some(LabelMatcher {
                name: "cluster".to_owned(),
                value: "prod".to_owned(),
            }),
            auth: basic("me"),
            ca_path: Some("/etc/ssl/mimir-ca.pem".to_owned()),
        };
        let wire = json!({
            "kind": "remote",
            "url": "https://mimir.example.com/prometheus",
            "tenant": "team-a",
            "matcher": { "name": "cluster", "value": "prod" },
            "auth": { "kind": "basic", "username": "me" },
            "caPath": "/etc/ssl/mimir-ca.pem",
        });
        assert_eq!(serde_json::to_value(&setting).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<MetricsProviderSetting>(wire).unwrap(),
            setting
        );
        for (auth, wire) in [
            (RemoteAuth::Anonymous, json!({ "kind": "none" })),
            (RemoteAuth::Bearer, json!({ "kind": "bearer" })),
            (
                mtls("/c.pem", "/k.pem"),
                json!({ "kind": "mtls", "certPath": "/c.pem", "keyPath": "/k.pem" }),
            ),
        ] {
            assert_eq!(serde_json::to_value(&auth).unwrap(), wire);
            assert_eq!(serde_json::from_value::<RemoteAuth>(wire).unwrap(), auth);
        }
    }

    #[test]
    fn a_remote_url_is_trimmed_and_names_only_a_scheme_host_port_and_path() {
        let url_of = |url: &str| match saved(remote(url, RemoteAuth::Anonymous)) {
            Ok(MetricsProviderSetting::Remote { url, .. }) => Ok(url),
            Ok(other) => panic!("{other:?}"),
            Err(message) => Err(message),
        };
        assert_eq!(
            url_of(" https://mimir.example.com/prometheus/ ").unwrap(),
            "https://mimir.example.com/prometheus"
        );
        assert_eq!(
            url_of("https://mimir.example.com//").unwrap(),
            "https://mimir.example.com"
        );
        assert_eq!(
            url_of("http://127.0.0.1:9009/prometheus").unwrap(),
            "http://127.0.0.1:9009/prometheus"
        );
        let text = "The URL must be http:// or https:// with a host, without a user name, query or fragment.";
        for bad in [
            "",
            "   ",
            "mimir.example.com",
            "/prometheus",
            "https://",
            "ftp://mimir.example.com",
            "file:///etc/prometheus",
            "https://me@mimir.example.com",
            "https://me:secret@mimir.example.com",
            "https://:secret@mimir.example.com",
            "https://mimir.example.com/?org=1",
            "https://mimir.example.com?",
            "https://mimir.example.com/#top",
        ] {
            assert_eq!(url_of(bad).unwrap_err(), text, "{bad:?}");
        }
    }

    #[test]
    fn basic_and_bearer_need_https_except_to_localhost_and_a_client_certificate_always() {
        let https_text = "Basic and Bearer credentials need https://, except to localhost.";
        for auth in [basic("me"), RemoteAuth::Bearer] {
            assert_eq!(
                saved(remote("http://mimir.example.com", auth.clone())).unwrap_err(),
                https_text
            );
            assert_eq!(
                saved(remote("http://10.0.0.1:9009", auth.clone())).unwrap_err(),
                https_text
            );
            for loopback in [
                "https://mimir.example.com",
                "http://localhost:9009",
                "http://LOCALHOST",
                "http://127.0.0.1:9009",
                "http://127.10.20.30",
                "http://[::1]:9009",
            ] {
                assert!(
                    saved(remote(loopback, auth.clone())).is_ok(),
                    "{loopback} {auth:?}"
                );
            }
        }
        assert!(saved(remote("http://mimir.example.com", RemoteAuth::Anonymous)).is_ok());

        let dir = tempfile::tempdir().unwrap();
        let cert = dir.path().join("client.pem");
        let key = dir.path().join("client.key");
        std::fs::write(&cert, pem("CERTIFICATE")).unwrap();
        std::fs::write(&key, pem("PRIVATE KEY")).unwrap();
        let (cert, key) = (cert.to_str().unwrap(), key.to_str().unwrap());
        assert_eq!(
            saved(remote("http://127.0.0.1:9009", mtls(cert, key))).unwrap_err(),
            "A client certificate needs https://."
        );
        assert!(saved(remote("https://127.0.0.1:9009", mtls(cert, key))).is_ok());
    }

    #[test]
    fn a_basic_user_name_is_trimmed_and_holds_no_colon() {
        assert_eq!(
            saved(remote("https://mimir.example.com", basic(" me "))).unwrap(),
            remote("https://mimir.example.com", basic("me"))
        );
        let text = "The user name must not be empty or contain ':'.";
        for bad in ["", "  ", "me:you"] {
            assert_eq!(
                saved(remote("https://mimir.example.com", basic(bad))).unwrap_err(),
                text,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_remote_tenant_and_label_follow_the_prometheus_rules() {
        let with = |tenant: &str, name: &str, value: &str| MetricsProviderSetting::Remote {
            url: "https://mimir.example.com".to_owned(),
            tenant: Some(tenant.to_owned()),
            matcher: Some(LabelMatcher {
                name: name.to_owned(),
                value: value.to_owned(),
            }),
            auth: RemoteAuth::Anonymous,
            ca_path: Some("  ".to_owned()),
        };
        assert_eq!(
            saved(with(" team-a ", " cluster ", "prod")).unwrap(),
            MetricsProviderSetting::Remote {
                url: "https://mimir.example.com".to_owned(),
                tenant: Some("team-a".to_owned()),
                matcher: Some(LabelMatcher {
                    name: "cluster".to_owned(),
                    value: "prod".to_owned(),
                }),
                auth: RemoteAuth::Anonymous,
                ca_path: None,
            }
        );
        assert!(matches!(
            saved(with("", "", "")).unwrap(),
            MetricsProviderSetting::Remote {
                tenant: None,
                matcher: None,
                ..
            }
        ));
        assert_eq!(
            saved(with("a|b", "", "")).unwrap_err(),
            "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters."
        );
        assert_eq!(
            saved(with("", "__name__", "up")).unwrap_err(),
            "A label name is letters, digits and _, and does not start with __."
        );
        assert_eq!(
            saved(with("", "cluster", "")).unwrap_err(),
            "A cluster label needs a name and a value."
        );
    }

    #[test]
    fn certificate_and_key_files_are_absolute_and_hold_pem() {
        let dir = tempfile::tempdir().unwrap();
        let file = |name: &str, content: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, content).unwrap();
            path.to_str().unwrap().to_owned()
        };
        let ca = file(
            "ca.pem",
            &format!("{}{}", pem("CERTIFICATE"), pem("CERTIFICATE")),
        );
        let cert = file("client.pem", &format!("comment\n{}", pem("CERTIFICATE")));
        let pkcs8 = file("pkcs8.key", &pem("PRIVATE KEY"));
        let rsa = file("rsa.key", &pem("RSA PRIVATE KEY"));
        let ec = file("ec.key", &pem("EC PRIVATE KEY"));
        let encrypted = file("encrypted.key", &pem("ENCRYPTED PRIVATE KEY"));
        let empty = file("empty.pem", "");
        let missing = dir.path().join("missing.pem");
        let missing_reason = std::fs::read(&missing).unwrap_err().to_string();
        let missing = missing.to_str().unwrap().to_owned();

        let url = "https://mimir.example.com";
        let with_ca = |ca_path: &str, auth: RemoteAuth| MetricsProviderSetting::Remote {
            url: url.to_owned(),
            tenant: None,
            matcher: None,
            auth,
            ca_path: Some(ca_path.to_owned()),
        };
        // Paths are trimmed and kept; the files stay where they are (spec I36).
        assert_eq!(
            saved(with_ca(
                &format!(" {ca} "),
                mtls(&format!(" {cert} "), &pkcs8)
            ))
            .unwrap(),
            with_ca(&ca, mtls(&cert, &pkcs8))
        );
        for key in [&rsa, &ec] {
            assert!(saved(remote(url, mtls(&cert, key))).is_ok(), "{key}");
        }
        assert!(saved(with_ca(&ca, RemoteAuth::Bearer)).is_ok());

        assert_eq!(
            saved(with_ca(&pkcs8, RemoteAuth::Anonymous)).unwrap_err(),
            format!("{pkcs8} holds no PEM certificate. [caPath]")
        );
        assert_eq!(
            saved(remote(url, mtls(&empty, &pkcs8))).unwrap_err(),
            format!("{empty} holds no PEM certificate. [certPath]")
        );
        for key in [&encrypted, &cert] {
            assert_eq!(
                saved(remote(url, mtls(&cert, key))).unwrap_err(),
                format!(
                    "{key} holds no unencrypted PEM private key (PKCS#8, RSA or EC). [keyPath]"
                )
            );
        }
        assert_eq!(
            saved(with_ca(&missing, RemoteAuth::Anonymous)).unwrap_err(),
            format!("{missing} could not be read: {missing_reason}. [caPath]")
        );
        assert_eq!(
            saved(with_ca("ca.pem", RemoteAuth::Anonymous)).unwrap_err(),
            "The CA file must be an absolute path. [caPath]"
        );
        assert_eq!(
            saved(remote(url, mtls(" ", &pkcs8))).unwrap_err(),
            "The certificate file must be an absolute path. [certPath]"
        );
        assert_eq!(
            saved(remote(url, mtls(&cert, "client.key"))).unwrap_err(),
            "The key file must be an absolute path. [keyPath]"
        );
    }

    /// Review Focus 5: the punctuation Mimir allows is kept; anything else is refused.
    #[test]
    fn a_remote_tenant_keeps_every_character_mimir_allows() {
        let with_tenant = |tenant: &str| MetricsProviderSetting::Remote {
            url: "https://mimir.example.com".to_owned(),
            tenant: Some(tenant.to_owned()),
            matcher: None,
            auth: RemoteAuth::Anonymous,
            ca_path: None,
        };
        let allowed = "Team.A_1-(prod)*'!";
        assert_eq!(
            saved(with_tenant(&format!(" {allowed} "))).unwrap(),
            with_tenant(allowed)
        );
        assert!(saved(with_tenant(&"a".repeat(150))).is_ok());
        let text =
            "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters.";
        let long = "a".repeat(151);
        for bad in [
            "team a",
            "team/a",
            "équipe",
            ".",
            "..",
            "__mimir_cluster",
            long.as_str(),
        ] {
            assert_eq!(saved(with_tenant(bad)).unwrap_err(), text, "{bad:?}");
        }
    }
}
