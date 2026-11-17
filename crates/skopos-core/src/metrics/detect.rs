//! Where a cluster's metrics come from (spec §5.4): the setting, or detection cached per
//! cluster.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use http::Request;
use k8s_openapi::api::core::v1::{Service, ServicePort};
use kube::api::ListParams;
use kube::{Api, Client};

use super::prometheus::{Endpoint, Transport};
use super::remote::{Remote, RemoteEndpoint};
use super::{
    remote_url_of, MetricsProvider, MetricsProviderSetting, MetricsServerChoice, NoProviderChoice,
    PrometheusChoice, RemoteChoice, METRICS_API,
};
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::secrets::Secret;

/// The waits of F16. Tests shorten them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricsLimits {
    /// How long a detection probe waits for Prometheus.
    pub probe: Duration,
    /// How long one range query waits.
    pub query: Duration,
    /// How long a detection is kept.
    pub cache: Duration,
}

impl Default for MetricsLimits {
    fn default() -> Self {
        Self {
            probe: Duration::from_secs(5),
            query: Duration::from_secs(15),
            cache: Duration::from_secs(600),
        }
    }
}

/// The provider in use and, for Prometheus, where to reach it.
#[derive(Debug, Clone)]
pub(crate) struct Chosen {
    pub(crate) provider: MetricsProvider,
    pub(crate) api: Option<PrometheusApi>,
}

/// Where a Prometheus API is, by the transport that reaches it (spec I37).
#[derive(Debug, Clone)]
pub(crate) enum PrometheusApi {
    ServiceProxy(Endpoint),
    Remote(RemoteEndpoint),
}

struct Cached {
    /// The connection the detection ran on.
    epoch: u64,
    at: Instant,
    chosen: Chosen,
}

/// F16's state in `AppCore`: one detection and one URL client per cluster, and the limits.
#[derive(Default)]
pub(crate) struct Metrics {
    cache: DashMap<ClusterId, Cached>,
    remotes: DashMap<ClusterId, Arc<Remote>>,
    limits: Mutex<MetricsLimits>,
}

impl Metrics {
    pub(crate) fn limits(&self) -> MetricsLimits {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_limits(&self, limits: MetricsLimits) {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner) = limits;
    }

    /// The detection made on this connection, while it is fresh.
    fn cached(&self, id: &ClusterId, epoch: u64) -> Option<Chosen> {
        let keep_for = self.limits().cache;
        let entry = self.cache.get(id)?;
        (entry.epoch == epoch && entry.at.elapsed() < keep_for).then(|| entry.chosen.clone())
    }

    fn store(&self, id: &ClusterId, epoch: u64, chosen: &Chosen) {
        self.cache.insert(
            id.clone(),
            Cached {
                epoch,
                at: Instant::now(),
                chosen: chosen.clone(),
            },
        );
    }

    pub(crate) fn forget(&self, id: &ClusterId) {
        self.cache.remove(id);
    }

    /// The cluster's client for `endpoint` and `secret`: the one kept, unless the setting or
    /// the secret changed since it was built (spec I41).
    pub(crate) fn remote(
        &self,
        id: &ClusterId,
        endpoint: &RemoteEndpoint,
        secret: Option<Secret>,
    ) -> CoreResult<Arc<Remote>> {
        let kept = self
            .remotes
            .get(id)
            .filter(|remote| remote.serves(endpoint, secret.as_ref()))
            .map(|remote| Arc::clone(&remote));
        if let Some(remote) = kept {
            return Ok(remote);
        }
        let remote = Arc::new(Remote::new(endpoint.clone(), secret)?);
        self.remotes.insert(id.clone(), Arc::clone(&remote));
        Ok(remote)
    }

    /// Drops the cluster's client, so the next query reads the files again.
    pub(crate) fn forget_remote(&self, id: &ClusterId) {
        self.remotes.remove(id);
    }
}

impl AppCore {
    /// Where this cluster's metrics come from. `refresh` drops the cached detection.
    pub async fn metrics_provider(
        &self,
        id: &ClusterId,
        refresh: bool,
    ) -> CoreResult<MetricsProvider> {
        Ok(self.chosen_provider(id, refresh).await?.provider)
    }

    /// Shortens F16's waits, so tests reach a timeout or an expiry quickly.
    pub fn set_metrics_limits_for_test(&self, limits: MetricsLimits) {
        self.metrics().set_limits(limits);
    }

    pub(crate) async fn chosen_provider(
        &self,
        id: &ClusterId,
        refresh: bool,
    ) -> CoreResult<Chosen> {
        // `Unreachable` when the cluster is not connected.
        let epoch = self.connections().epoch(id)?;
        if let Some(chosen) = from_setting(&self.cluster_settings_get(id).metrics_provider)? {
            return Ok(chosen);
        }
        let metrics = self.metrics();
        if refresh {
            metrics.forget(id);
        }
        if let Some(chosen) = metrics.cached(id, epoch) {
            return Ok(chosen);
        }
        let namespaces = match self.cluster_state(id) {
            ConnectionState::Connected { info } => info.namespaces,
            _ => Vec::new(),
        };
        let chosen = detect(&self.cluster_client(id)?, &namespaces, metrics.limits()).await?;
        metrics.store(id, epoch, &chosen);
        Ok(chosen)
    }
}

/// A pinned provider, used without a probe (spec I43). `None` for `auto`.
fn from_setting(setting: &MetricsProviderSetting) -> CoreResult<Option<Chosen>> {
    let chosen = match setting {
        MetricsProviderSetting::Auto => return Ok(None),
        MetricsProviderSetting::Prometheus {
            namespace,
            service,
            port,
            scheme,
            path_prefix,
            tenant,
            matcher,
        } => {
            let endpoint = Endpoint {
                namespace: namespace.clone(),
                service: service.clone(),
                port: *port,
                scheme: *scheme,
                path_prefix: path_prefix.clone(),
                tenant: tenant.clone(),
                matcher: matcher.clone(),
            };
            Chosen {
                provider: prometheus_provider(&endpoint, PrometheusChoice::Setting),
                api: Some(PrometheusApi::ServiceProxy(endpoint)),
            }
        }
        MetricsProviderSetting::Remote {
            url,
            tenant,
            matcher,
            auth,
            ca_path,
        } => {
            let endpoint = RemoteEndpoint {
                url: remote_url_of(url)?.1,
                tenant: tenant.clone(),
                matcher: matcher.clone(),
                auth: auth.clone(),
                ca_path: ca_path.clone(),
            };
            Chosen {
                provider: MetricsProvider::Remote {
                    host: endpoint.host(),
                    tenant: tenant.clone(),
                    matcher: matcher.clone(),
                    chosen_by: RemoteChoice::Setting,
                },
                api: Some(PrometheusApi::Remote(endpoint)),
            }
        }
        MetricsProviderSetting::MetricsServer => Chosen {
            provider: MetricsProvider::MetricsServer {
                chosen_by: MetricsServerChoice::Setting,
            },
            api: None,
        },
        MetricsProviderSetting::Off => Chosen {
            provider: MetricsProvider::Off {
                chosen_by: NoProviderChoice::Setting,
            },
            api: None,
        },
    };
    Ok(Some(chosen))
}

/// The first candidate that answers the probe; else the first one refused with 403 (so queries
/// report `Forbidden`); else metrics-server, else none.
async fn detect(
    client: &Client,
    namespaces: &[String],
    limits: MetricsLimits,
) -> CoreResult<Chosen> {
    let services = list_services(client, namespaces).await?;
    let mut refused: Option<Candidate> = None;
    for candidate in candidates(&services) {
        let transport = Transport::ServiceProxy {
            client,
            endpoint: &candidate.endpoint,
        };
        match transport.probe(limits.probe).await {
            Ok(()) => return Ok(prometheus_chosen(candidate)),
            // Remember the first refusal: if nothing answers, the user must see
            // `Forbidden` naming the permission, not "no Prometheus".
            Err(e) if e.code == ErrorCode::Forbidden && refused.is_none() => {
                refused = Some(candidate);
            }
            Err(_) => {}
        }
    }
    if let Some(candidate) = refused {
        return Ok(prometheus_chosen(candidate));
    }
    let provider = if serves_metrics_api(client).await? {
        MetricsProvider::MetricsServer {
            chosen_by: MetricsServerChoice::Fallback,
        }
    } else {
        MetricsProvider::Off {
            chosen_by: NoProviderChoice::NothingFound,
        }
    };
    Ok(Chosen {
        provider,
        api: None,
    })
}

fn prometheus_chosen(candidate: Candidate) -> Chosen {
    Chosen {
        provider: prometheus_provider(&candidate.endpoint, candidate.tier),
        api: Some(PrometheusApi::ServiceProxy(candidate.endpoint)),
    }
}

/// The provider the interface shows for this Endpoint (spec I19).
fn prometheus_provider(endpoint: &Endpoint, chosen_by: PrometheusChoice) -> MetricsProvider {
    MetricsProvider::Prometheus {
        namespace: endpoint.namespace.clone(),
        service: endpoint.service.clone(),
        port: endpoint.port,
        scheme: endpoint.scheme,
        path_prefix: endpoint.path_prefix.clone(),
        tenant: endpoint.tenant.clone(),
        matcher: endpoint.matcher.clone(),
        chosen_by,
    }
}

/// Every Service the user may list: one list across namespaces or, when that is forbidden,
/// one per accessible namespace, four at a time, skipping those that fail.
async fn list_services(client: &Client, namespaces: &[String]) -> CoreResult<Vec<Service>> {
    match Api::<Service>::all(client.clone())
        .list(&ListParams::default())
        .await
    {
        Ok(list) => Ok(list.items),
        Err(kube::Error::Api(status)) if status.code == 403 => {
            let lists: Vec<_> = stream::iter(namespaces.iter().cloned())
                .map(|namespace| {
                    let api = Api::<Service>::namespaced(client.clone(), &namespace);
                    async move { api.list(&ListParams::default()).await }
                })
                .buffered(4)
                .collect()
                .await;
            Ok(lists
                .into_iter()
                .filter_map(Result::ok)
                .flat_map(|list| list.items)
                .collect())
        }
        Err(e) => Err(e.into()),
    }
}

/// A Service that may be Prometheus.
struct Candidate {
    tier: PrometheusChoice,
    endpoint: Endpoint,
}

/// The candidates in probe order: by tier, then `monitoring` first, then namespace and name.
fn candidates(services: &[Service]) -> Vec<Candidate> {
    let mut found: Vec<Candidate> = services
        .iter()
        .filter_map(|service| {
            let (tier, preferred) = tier(service)?;
            let ports = service.spec.as_ref()?.ports.as_deref()?;
            Some(Candidate {
                tier,
                endpoint: Endpoint {
                    namespace: service.metadata.namespace.clone()?,
                    service: service.metadata.name.clone()?,
                    port: pick_port(ports, preferred)?,
                    scheme: None,
                    path_prefix: None,
                    tenant: None,
                    matcher: None,
                },
            })
        })
        .collect();
    found.sort_by(|a, b| order(a).cmp(&order(b)));
    found
}

fn order(candidate: &Candidate) -> (PrometheusChoice, bool, &str, &str) {
    let endpoint = &candidate.endpoint;
    (
        candidate.tier,
        endpoint.namespace != "monitoring",
        endpoint.namespace.as_str(),
        endpoint.service.as_str(),
    )
}

/// The tier a Service belongs to, with the port names that tier serves on.
fn tier(service: &Service) -> Option<(PrometheusChoice, &'static [&'static str])> {
    let labels = service.metadata.labels.as_ref()?;
    let label = |key: &str| labels.get(key).map(String::as_str);
    if label("app") == Some("kube-prometheus-stack-prometheus") {
        return Some((PrometheusChoice::KubePrometheusStack, &["http-web"]));
    }
    if label("operated-prometheus") == Some("true") {
        return Some((PrometheusChoice::Operator, &["web"]));
    }
    if label("app.kubernetes.io/name") != Some("prometheus") {
        return None;
    }
    if label("app.kubernetes.io/component") == Some("server") {
        Some((PrometheusChoice::CommunityChart, &["http"]))
    } else {
        Some((PrometheusChoice::Label, &[]))
    }
}

/// The tier's port name, else `web`, `http` or `http-web`, else 9090, else the first port.
fn pick_port(ports: &[ServicePort], preferred: &[&str]) -> Option<u16> {
    let named = |name: &&str| ports.iter().find(|p| p.name.as_deref() == Some(*name));
    let port = preferred
        .iter()
        .chain(["web", "http", "http-web"].iter())
        .find_map(named)
        .or_else(|| ports.iter().find(|p| p.port == 9090))
        .or_else(|| ports.first())?;
    u16::try_from(port.port).ok()
}

/// Whether metrics-server answers now. Read fresh rather than from the connection's
/// discovery, since it may have been installed after the connection. 404 means not
/// registered; 503 means registered but unavailable.
async fn serves_metrics_api(client: &Client) -> CoreResult<bool> {
    let request = Request::get(METRICS_API).body(Vec::new()).map_err(|e| {
        IpcError::new(
            ErrorCode::Internal,
            format!("could not build the discovery request: {e}"),
        )
    })?;
    match client.request_text(request).await {
        Ok(_) => Ok(true),
        Err(kube::Error::Api(status)) if matches!(status.code, 404 | 503) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::metrics::{RemoteAuth, RemoteChoice};

    fn service(namespace: &str, name: &str, labels: Value, ports: Value) -> Service {
        serde_json::from_value(json!({
            "metadata": { "namespace": namespace, "name": name, "labels": labels },
            "spec": { "ports": ports },
        }))
        .unwrap()
    }

    fn port(name: &str, number: i32) -> Value {
        json!({ "name": name, "port": number })
    }

    fn chart(namespace: &str, name: &str) -> Service {
        service(
            namespace,
            name,
            json!({ "app.kubernetes.io/name": "prometheus", "app.kubernetes.io/component": "server" }),
            json!([port("http", 80)]),
        )
    }

    /// `tier namespace/service:port`, in probe order.
    fn found(services: &[Service]) -> Vec<String> {
        candidates(services)
            .into_iter()
            .map(|c| {
                format!(
                    "{:?} {}/{}:{}",
                    c.tier, c.endpoint.namespace, c.endpoint.service, c.endpoint.port
                )
            })
            .collect()
    }

    #[test]
    fn each_tier_has_its_labels_and_port() {
        let label = json!({ "app.kubernetes.io/name": "prometheus" });
        let services = [
            service(
                "a",
                "kps",
                json!({ "app": "kube-prometheus-stack-prometheus" }),
                json!([port("reloader-web", 8080), port("http-web", 9090)]),
            ),
            service(
                "a",
                "prometheus-operated",
                json!({ "operated-prometheus": "true" }),
                json!([port("web", 9090)]),
            ),
            chart("a", "chart"),
            service(
                "a",
                "named",
                label.clone(),
                json!([port("metrics", 8080), port("web", 9091)]),
            ),
            service(
                "a",
                "numbered",
                label.clone(),
                json!([port("metrics", 8080), port("other", 9090)]),
            ),
            service(
                "a",
                "first",
                label.clone(),
                json!([port("metrics", 8080), port("other", 8081)]),
            ),
            service("a", "portless", label, json!([])),
            service(
                "a",
                "grafana",
                json!({ "app.kubernetes.io/name": "grafana" }),
                json!([port("http", 80)]),
            ),
        ];
        assert_eq!(
            found(&services),
            [
                "KubePrometheusStack a/kps:9090",
                "Operator a/prometheus-operated:9090",
                "CommunityChart a/chart:80",
                "Label a/first:8080",
                "Label a/named:9091",
                "Label a/numbered:9090",
            ]
        );
    }

    #[test]
    fn a_remote_setting_is_used_as_it_is_and_shows_only_its_host() {
        let setting = MetricsProviderSetting::Remote {
            url: "https://mimir.example.com:8443/prometheus".to_owned(),
            tenant: Some("team-a".to_owned()),
            matcher: None,
            auth: RemoteAuth::Bearer,
            ca_path: None,
        };
        let chosen = from_setting(&setting).unwrap().unwrap();
        assert_eq!(
            chosen.provider,
            MetricsProvider::Remote {
                host: "mimir.example.com:8443".to_owned(),
                tenant: Some("team-a".to_owned()),
                matcher: None,
                chosen_by: RemoteChoice::Setting,
            }
        );
        let Some(PrometheusApi::Remote(endpoint)) = chosen.api else {
            panic!("{:?}", chosen.api);
        };
        assert_eq!(
            endpoint.url.as_str(),
            "https://mimir.example.com:8443/prometheus"
        );
        assert_eq!(endpoint.tenant.as_deref(), Some("team-a"));
        assert_eq!(endpoint.auth, RemoteAuth::Bearer);
    }

    #[test]
    fn within_a_tier_monitoring_comes_first_then_namespace_and_name() {
        let services = [
            chart("zeta", "a"),
            chart("alpha", "b"),
            chart("monitoring", "z"),
            chart("alpha", "a"),
            service(
                "zeta",
                "kps",
                json!({ "app": "kube-prometheus-stack-prometheus" }),
                json!([port("http-web", 9090)]),
            ),
        ];
        assert_eq!(
            found(&services),
            [
                "KubePrometheusStack zeta/kps:9090",
                "CommunityChart monitoring/z:80",
                "CommunityChart alpha/a:80",
                "CommunityChart alpha/b:80",
                "CommunityChart zeta/a:80",
            ]
        );
    }
}
