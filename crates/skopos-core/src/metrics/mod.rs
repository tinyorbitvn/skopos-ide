//! Metrics (F16): the provider setting, detection of Prometheus or metrics-server with a cache
//! per cluster, and the queries the interface repeats on its own timer (spec §5.4).

mod detect;
pub(crate) mod prometheus;
mod query;
pub(crate) mod templates;
pub(crate) use detect::Metrics;
pub use detect::MetricsLimits;
mod usage;
pub(crate) use usage::METRICS_API;
pub use usage::{UsageItem, UsageOf, UsageSnapshot};

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::CoreResult;
use crate::resources::invalid;

/// `ClusterSettings.metricsProvider`: detect, pin one Prometheus Service, use metrics-server
/// alone, or show no metrics.
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
/// Mimir's longest tenant ID.
const TENANT_MAX: usize = 150;
const LABEL_VALUE_MAX: usize = 1024;

impl MetricsProviderSetting {
    /// The setting as it is saved. A pinned Service has its names checked, its path prefix
    /// trimmed to `/a/b` form or `None`, its tenant and cluster label checked (spec I2, I3).
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
            return Ok(self);
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
/// bytes per second; pods as counts.
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
    /// Asked for this target, but no data: the query failed or returned no samples.
    pub missing: Vec<MetricName>,
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
        chosen_by: PrometheusChoice,
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
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({
                "start": 0,
                "end": 60,
                "step": 60,
                "series": { "cpuUsage": [[60.0, 0.5]] },
                "missing": ["fsUsage"],
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
}
