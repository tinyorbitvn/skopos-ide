//! The control plane's health for the cluster Overview: the API server's own endpoints, and
//! etcd, the scheduler, the controller manager, DNS and kube-proxy as `kube-system` shows
//! them. What the user may not see is left out, never an error; only an API server that
//! cannot be reached fails the call.

use http::StatusCode;
use k8s_openapi::jiff::fmt::rfc2822;
use k8s_openapi::jiff::Timestamp;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::get_raw;
use super::raw::RawResponse;
use super::state::ConnectionState;
use crate::app_core::AppCore;
use crate::error::CoreResult;
use crate::kubeconfig::ClusterId;

const KUBE_SYSTEM: &str = "api/v1/namespaces/kube-system";
const APPS_KUBE_SYSTEM: &str = "apis/apps/v1/namespaces/kube-system";
const LEASES_KUBE_SYSTEM: &str = "apis/coordination.k8s.io/v1/namespaces/kube-system/leases";
/// A Lease without `leaseDurationSeconds` is judged by the default of the leader election.
const DEFAULT_LEASE_SECONDS: u32 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HealthState {
    Healthy,
    Degraded,
    Unhealthy,
    Unknown,
}

impl HealthState {
    /// How bad: the worst of several sources wins.
    fn severity(self) -> u8 {
        match self {
            Self::Unknown | Self::Healthy => 0,
            Self::Degraded => 1,
            Self::Unhealthy => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HealthCheck {
    pub name: String,
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApiServer {
    /// The cluster's server URL from its kubeconfig.
    pub url: String,
    /// `/version`'s `gitVersion`.
    pub version: String,
    pub platform: Option<String>,
    pub go_version: Option<String>,
    /// As `/version` gives it.
    pub build_date: Option<String>,
    /// `GET /livez`.
    pub live: HealthState,
    /// From the status of `GET /readyz?verbose`.
    pub ready: HealthState,
    /// The lines of `/readyz?verbose`, in server order.
    pub checks: Vec<HealthCheck>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PodCounts {
    pub ready: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Leader {
    /// `""` when the Lease names none.
    pub holder: String,
    /// The Lease's `renewTime` as given.
    pub renewed: Option<String>,
    pub lease_seconds: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ControlPlaneComponent {
    /// `etcd`, `scheduler`, `controller-manager`, `dns` or `proxy`.
    pub id: String,
    pub name: String,
    pub state: HealthState,
    #[ts(inline)]
    pub pods: Option<PodCounts>,
    #[ts(inline)]
    pub leader: Option<Leader>,
    /// The matching `/readyz` check, for etcd only.
    pub check: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ControlPlane {
    pub api_server: ApiServer,
    pub components: Vec<ControlPlaneComponent>,
}

/// What reading one source gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fetch<T> {
    Visible(T),
    /// 401 or 403.
    Forbidden,
    NotFound,
    /// Any other status, or an answer that could not be read.
    Failed,
}

impl<T> Fetch<T> {
    fn visible(&self) -> Option<&T> {
        match self {
            Self::Visible(value) => Some(value),
            _ => None,
        }
    }
}

/// A Lease as read: who leads, and whether the leader is alive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LeaseReading {
    leader: Leader,
    state: HealthState,
}

/// Every source's outcome, before they become components.
pub(crate) struct Outcomes {
    pub(crate) etcd_check: Option<bool>,
    pub(crate) etcd_pods: Fetch<PodCounts>,
    pub(crate) scheduler_lease: Fetch<LeaseReading>,
    pub(crate) scheduler_pods: Fetch<PodCounts>,
    pub(crate) controller_manager_lease: Fetch<LeaseReading>,
    pub(crate) controller_manager_pods: Fetch<PodCounts>,
    pub(crate) dns: Fetch<PodCounts>,
    pub(crate) proxy: Fetch<PodCounts>,
}

/// 200 is healthy, 401 and 403 (no right to the non-resource URL) say nothing, the rest is not.
pub(crate) fn health_of_status(status: StatusCode) -> HealthState {
    match status.as_u16() {
        200 => HealthState::Healthy,
        401 | 403 => HealthState::Unknown,
        _ => HealthState::Unhealthy,
    }
}

/// The `[+]name ok` and `[-]name failed…` lines of `/readyz?verbose`, in order.
pub(crate) fn parse_readyz_checks(body: &str) -> Vec<HealthCheck> {
    body.lines()
        .filter_map(|line| {
            let (ok, rest) = if let Some(rest) = line.strip_prefix("[+]") {
                (true, rest)
            } else {
                (false, line.strip_prefix("[-]")?)
            };
            let name = rest.split(' ').next().unwrap_or_default();
            (!name.is_empty()).then(|| HealthCheck {
                name: name.to_owned(),
                ok,
            })
        })
        .collect()
}

/// The worst state among the sources that could be seen, `Unknown` when none could.
pub(crate) fn worst(states: impl IntoIterator<Item = HealthState>) -> HealthState {
    states
        .into_iter()
        .max_by_key(|state| state.severity())
        .unwrap_or(HealthState::Unknown)
}

pub(crate) fn pods_state(counts: PodCounts) -> HealthState {
    if counts.total == 0 || counts.ready == 0 {
        HealthState::Unhealthy
    } else if counts.ready >= counts.total {
        HealthState::Healthy
    } else {
        HealthState::Degraded
    }
}

/// A leader that has not renewed for twice its lease duration is gone, as is a Lease nobody
/// holds. `now` is the API server's clock, so a skewed local clock cannot fake a stale leader.
pub(crate) fn lease_state(
    holder: &str,
    renewed: Option<&str>,
    lease_seconds: Option<u32>,
    now: Timestamp,
) -> HealthState {
    let renewed = renewed.and_then(|text| text.parse::<Timestamp>().ok());
    let (false, Some(renewed)) = (holder.is_empty(), renewed) else {
        return HealthState::Unhealthy;
    };
    let limit = 2 * i64::from(lease_seconds.unwrap_or(DEFAULT_LEASE_SECONDS));
    if now.as_second() - renewed.as_second() > limit {
        HealthState::Unhealthy
    } else {
        HealthState::Healthy
    }
}

/// The server's clock from a `Date` header (an HTTP date), or the local clock.
pub(crate) fn server_time(date: Option<&str>) -> Timestamp {
    date.and_then(|text| rfc2822::parse(text).ok())
        .map_or_else(Timestamp::now, |zoned| zoned.timestamp())
}

fn count(value: &Value) -> Option<u32> {
    u32::try_from(value.as_u64()?).ok()
}

fn pod_is_ready(pod: &Value) -> bool {
    pod["status"]["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|c| c["type"] == "Ready" && c["status"] == "True")
}

/// Reads a successful answer with `read`, or says why it could not be.
fn fetch_with<T>(raw: &RawResponse, read: impl FnOnce(&Value) -> Fetch<T>) -> Fetch<T> {
    match raw.status.as_u16() {
        200..=299 => serde_json::from_slice(&raw.body).map_or(Fetch::Failed, |v| read(&v)),
        401 | 403 => Fetch::Forbidden,
        404 => Fetch::NotFound,
        _ => Fetch::Failed,
    }
}

/// Pods from a list. No Pod at all counts as not seen.
pub(crate) fn read_pod_list(list: &Value) -> Fetch<PodCounts> {
    let items = list["items"].as_array().map_or(&[][..], Vec::as_slice);
    if items.is_empty() {
        return Fetch::NotFound;
    }
    let ready = items.iter().filter(|pod| pod_is_ready(pod)).count();
    Fetch::Visible(PodCounts {
        ready: u32::try_from(ready).unwrap_or(u32::MAX),
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
    })
}

/// DNS Deployments: ready replicas over wanted ones (one when `spec.replicas` is absent).
pub(crate) fn read_deployments(list: &Value) -> Fetch<PodCounts> {
    let items = list["items"].as_array().map_or(&[][..], Vec::as_slice);
    if items.is_empty() {
        return Fetch::NotFound;
    }
    let sum = |read: fn(&Value) -> u32| items.iter().map(read).fold(0u32, u32::saturating_add);
    Fetch::Visible(PodCounts {
        ready: sum(|d| count(&d["status"]["readyReplicas"]).unwrap_or(0)),
        total: sum(|d| count(&d["spec"]["replicas"]).unwrap_or(1)),
    })
}

fn read_daemon_set(daemon_set: &Value) -> Fetch<PodCounts> {
    Fetch::Visible(PodCounts {
        ready: count(&daemon_set["status"]["numberReady"]).unwrap_or(0),
        total: count(&daemon_set["status"]["desiredNumberScheduled"]).unwrap_or(0),
    })
}

fn read_lease(lease: &Value, now: Timestamp) -> Fetch<LeaseReading> {
    let spec = &lease["spec"];
    let holder = spec["holderIdentity"].as_str().unwrap_or_default();
    let renewed = spec["renewTime"].as_str();
    let lease_seconds = count(&spec["leaseDurationSeconds"]);
    Fetch::Visible(LeaseReading {
        leader: Leader {
            holder: holder.to_owned(),
            renewed: renewed.map(str::to_owned),
            lease_seconds,
        },
        state: lease_state(holder, renewed, lease_seconds, now),
    })
}

fn component(
    id: &str,
    name: &str,
    states: Vec<HealthState>,
    pods: Option<PodCounts>,
    leader: Option<Leader>,
    check: Option<bool>,
) -> ControlPlaneComponent {
    ControlPlaneComponent {
        id: id.to_owned(),
        name: name.to_owned(),
        state: worst(states),
        pods,
        leader,
        check,
    }
}

/// The components, in display order. kube-proxy is left out when its DaemonSet does not exist.
pub(crate) fn assemble(outcomes: &Outcomes) -> Vec<ControlPlaneComponent> {
    let pods = |fetch: &Fetch<PodCounts>| fetch.visible().copied();
    let pods_states = |fetch: &Fetch<PodCounts>| pods(fetch).map(pods_state);
    let lease = |fetch: &Fetch<LeaseReading>| fetch.visible().cloned();
    let with_lease =
        |id: &str, name: &str, lease_fetch: &Fetch<LeaseReading>, pods_fetch: &Fetch<PodCounts>| {
            let reading = lease(lease_fetch);
            component(
                id,
                name,
                reading
                    .iter()
                    .map(|r| r.state)
                    .chain(pods_states(pods_fetch))
                    .collect(),
                pods(pods_fetch),
                reading.map(|r| r.leader),
                None,
            )
        };
    let from_pods = |id: &str, name: &str, fetch: &Fetch<PodCounts>| {
        component(
            id,
            name,
            pods_states(fetch).into_iter().collect(),
            pods(fetch),
            None,
            None,
        )
    };
    let check_state = outcomes.etcd_check.map(|ok| {
        if ok {
            HealthState::Healthy
        } else {
            HealthState::Unhealthy
        }
    });
    let mut components = vec![
        component(
            "etcd",
            "etcd",
            check_state
                .into_iter()
                .chain(pods_states(&outcomes.etcd_pods))
                .collect(),
            pods(&outcomes.etcd_pods),
            None,
            outcomes.etcd_check,
        ),
        with_lease(
            "scheduler",
            "Scheduler",
            &outcomes.scheduler_lease,
            &outcomes.scheduler_pods,
        ),
        with_lease(
            "controller-manager",
            "Controller manager",
            &outcomes.controller_manager_lease,
            &outcomes.controller_manager_pods,
        ),
        from_pods("dns", "DNS", &outcomes.dns),
    ];
    if outcomes.proxy != Fetch::NotFound {
        components.push(from_pods("proxy", "kube-proxy", &outcomes.proxy));
    }
    components
}

/// `/version`'s fields, when it answered with them.
struct VersionInfo {
    version: String,
    platform: Option<String>,
    go_version: Option<String>,
    build_date: Option<String>,
}

fn read_version(raw: &RawResponse) -> Option<VersionInfo> {
    if !raw.status.is_success() {
        return None;
    }
    let body: Value = serde_json::from_slice(&raw.body).ok()?;
    let text = |key: &str| {
        body[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Some(VersionInfo {
        version: text("gitVersion")?,
        platform: text("platform"),
        go_version: text("goVersion"),
        build_date: text("buildDate"),
    })
}

impl AppCore {
    /// The control plane's health. Fails only when the API server cannot be reached.
    pub async fn cluster_control_plane(&self, id: &ClusterId) -> CoreResult<ControlPlane> {
        let client = self.cluster_client(id)?;
        let url = self.cluster_server_url(id)?;
        let recorded_version = match self.cluster_state(id) {
            ConnectionState::Connected { info } => info.version,
            _ => String::new(),
        };
        let pods_path =
            |component: &str| format!("/{KUBE_SYSTEM}/pods?labelSelector=component={component}");
        let lease_path = |name: &str| format!("/{LEASES_KUBE_SYSTEM}/{name}");
        // Owns its path, so it can be built in the argument list below.
        let get = |path: String| {
            let client = &client;
            async move { get_raw(client, &path).await }
        };
        let dns = async {
            let list = get(format!(
                "/{APPS_KUBE_SYSTEM}/deployments?labelSelector=k8s-app=kube-dns"
            ))
            .await?;
            let found = fetch_with(&list, read_deployments);
            if found != Fetch::NotFound {
                return CoreResult::Ok(found);
            }
            let one = get(format!("/{APPS_KUBE_SYSTEM}/deployments/coredns")).await?;
            Ok(fetch_with(&one, |deployment| {
                read_deployments(&serde_json::json!({ "items": [deployment] }))
            }))
        };
        let (
            version,
            live,
            ready,
            etcd_pods,
            scheduler_pods,
            controller_manager_pods,
            scheduler_lease,
            controller_manager_lease,
            dns,
            proxy,
        ) = tokio::join!(
            get("/version".to_owned()),
            get("/livez".to_owned()),
            get("/readyz?verbose".to_owned()),
            get(pods_path("etcd")),
            get(pods_path("kube-scheduler")),
            get(pods_path("kube-controller-manager")),
            get(lease_path("kube-scheduler")),
            get(lease_path("kube-controller-manager")),
            dns,
            get(format!("/{APPS_KUBE_SYSTEM}/daemonsets/kube-proxy")),
        );
        let (version, live, ready) = (version?, live?, ready?);
        let (etcd_pods, scheduler_pods, controller_manager_pods) =
            (etcd_pods?, scheduler_pods?, controller_manager_pods?);
        let (scheduler_lease, controller_manager_lease) =
            (scheduler_lease?, controller_manager_lease?);
        let (dns, proxy) = (dns?, proxy?);

        let readable = !matches!(ready.status.as_u16(), 401 | 403);
        let checks = if readable {
            parse_readyz_checks(&String::from_utf8_lossy(&ready.body))
        } else {
            Vec::new()
        };
        let etcd_check = checks.iter().find(|c| c.name == "etcd").map(|c| c.ok);
        let lease = |raw: &RawResponse| {
            let now = server_time(raw.date.as_deref());
            fetch_with(raw, |lease| read_lease(lease, now))
        };
        let outcomes = Outcomes {
            etcd_check,
            etcd_pods: fetch_with(&etcd_pods, read_pod_list),
            scheduler_lease: lease(&scheduler_lease),
            scheduler_pods: fetch_with(&scheduler_pods, read_pod_list),
            controller_manager_lease: lease(&controller_manager_lease),
            controller_manager_pods: fetch_with(&controller_manager_pods, read_pod_list),
            dns,
            proxy: fetch_with(&proxy, read_daemon_set),
        };
        let info = read_version(&version);
        let (version_text, platform, go_version, build_date) = match info {
            Some(info) => (
                info.version,
                info.platform,
                info.go_version,
                info.build_date,
            ),
            None => (recorded_version, None, None, None),
        };
        Ok(ControlPlane {
            api_server: ApiServer {
                url,
                version: if version_text.is_empty() {
                    "unknown".to_owned()
                } else {
                    version_text
                },
                platform,
                go_version,
                build_date,
                live: health_of_status(live.status),
                ready: health_of_status(ready.status),
                checks,
            },
            components: assemble(&outcomes),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ts(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn counts(ready: u32, total: u32) -> PodCounts {
        PodCounts { ready, total }
    }

    #[test]
    fn verbose_readyz_lines_become_checks_in_order() {
        let body = "[+]ping ok\n[+]log ok\n[-]etcd failed: reason withheld\n\
                    [+]poststarthook/start-kube-apiserver-admission-initializer ok\n\
                    [+]etcd-readiness ok\nreadyz check failed\n  indented\n[+] \n[x]foo ok\n";
        let checks = parse_readyz_checks(body);
        let names: Vec<_> = checks.iter().map(|c| (c.name.as_str(), c.ok)).collect();
        assert_eq!(
            names,
            [
                ("ping", true),
                ("log", true),
                ("etcd", false),
                (
                    "poststarthook/start-kube-apiserver-admission-initializer",
                    true
                ),
                ("etcd-readiness", true),
            ]
        );
        assert!(parse_readyz_checks("ok").is_empty());
        assert!(parse_readyz_checks("").is_empty());
    }

    #[test]
    fn endpoint_statuses_map_to_health() {
        let state = |code: u16| health_of_status(StatusCode::from_u16(code).unwrap());
        assert_eq!(state(200), HealthState::Healthy);
        assert_eq!(state(401), HealthState::Unknown);
        assert_eq!(state(403), HealthState::Unknown);
        assert_eq!(state(500), HealthState::Unhealthy);
        assert_eq!(state(404), HealthState::Unhealthy);
        assert_eq!(state(503), HealthState::Unhealthy);
    }

    #[test]
    fn pods_rule() {
        assert_eq!(pods_state(counts(3, 3)), HealthState::Healthy);
        assert_eq!(pods_state(counts(2, 3)), HealthState::Degraded);
        assert_eq!(pods_state(counts(0, 3)), HealthState::Unhealthy);
        assert_eq!(pods_state(counts(0, 0)), HealthState::Unhealthy);
    }

    #[test]
    fn worst_state_wins_and_nothing_seen_is_unknown() {
        use HealthState::*;
        assert_eq!(worst([Healthy, Degraded]), Degraded);
        assert_eq!(worst([Degraded, Unhealthy, Healthy]), Unhealthy);
        assert_eq!(worst([Healthy]), Healthy);
        assert_eq!(worst([]), Unknown);
    }

    #[test]
    fn lease_rule_uses_the_given_now() {
        let now = ts("2026-11-19T10:00:30Z");
        let state = |holder, renewed, seconds| lease_state(holder, renewed, seconds, now);
        // 30 s old, limit 2 x 15 s: still alive. 31 s old is stale.
        assert_eq!(
            state("a", Some("2026-11-19T10:00:00.000000Z"), Some(15)),
            HealthState::Healthy
        );
        assert_eq!(
            state("a", Some("2026-11-19T09:59:59Z"), Some(15)),
            HealthState::Unhealthy
        );
        // The default is 15 s.
        assert_eq!(
            state("a", Some("2026-11-19T10:00:00Z"), None),
            HealthState::Healthy
        );
        assert_eq!(
            state("a", Some("2026-11-19T09:59:00Z"), None),
            HealthState::Unhealthy
        );
        assert_eq!(
            state("a", Some("2026-11-19T09:59:00Z"), Some(60)),
            HealthState::Healthy
        );
        // A renewal ahead of the clock is not stale.
        assert_eq!(
            state("a", Some("2026-11-19T10:05:00Z"), Some(15)),
            HealthState::Healthy
        );
        assert_eq!(
            state("", Some("2026-11-19T10:00:00Z"), Some(15)),
            HealthState::Unhealthy
        );
        assert_eq!(state("a", None, Some(15)), HealthState::Unhealthy);
        assert_eq!(state("a", Some("soon"), Some(15)), HealthState::Unhealthy);
    }

    #[test]
    fn a_date_header_is_the_server_clock() {
        // A real weekday, as a server sends.
        assert_eq!(
            server_time(Some("Thu, 19 Nov 2026 10:00:00 GMT")),
            ts("2026-11-19T10:00:00Z")
        );
        let before = Timestamp::now();
        for bad in [
            None,
            Some(""),
            Some("yesterday"),
            Some("2026-11-19T10:00:00Z"),
        ] {
            let t = server_time(bad);
            assert!(t >= before && t <= Timestamp::now(), "{bad:?}");
        }
    }

    #[test]
    fn leases_keep_what_they_show() {
        let now = ts("2026-11-19T10:00:00Z");
        let full = json!({"spec": {
            "holderIdentity": "node-1_abc",
            "renewTime": "2026-11-19T09:59:58.123456Z",
            "leaseDurationSeconds": 15,
        }});
        assert_eq!(
            read_lease(&full, now),
            Fetch::Visible(LeaseReading {
                leader: Leader {
                    holder: "node-1_abc".into(),
                    renewed: Some("2026-11-19T09:59:58.123456Z".into()),
                    lease_seconds: Some(15),
                },
                state: HealthState::Healthy,
            })
        );
        let empty = json!({"spec": {}});
        assert_eq!(
            read_lease(&empty, now),
            Fetch::Visible(LeaseReading {
                leader: Leader {
                    holder: String::new(),
                    renewed: None,
                    lease_seconds: None,
                },
                state: HealthState::Unhealthy,
            })
        );
    }

    #[test]
    fn pods_are_ready_by_their_ready_condition() {
        let list = json!({"items": [
            {"status": {"conditions": [{"type": "Ready", "status": "True"}]}},
            {"status": {"conditions": [{"type": "Ready", "status": "False"}]}},
            {"status": {"conditions": [{"type": "PodScheduled", "status": "True"}]}},
            {"status": {}},
        ]});
        assert_eq!(read_pod_list(&list), Fetch::Visible(counts(1, 4)));
        assert_eq!(read_pod_list(&json!({"items": []})), Fetch::NotFound);
        assert_eq!(read_pod_list(&json!({})), Fetch::NotFound);
    }

    #[test]
    fn deployments_sum_ready_and_wanted_replicas() {
        let list = json!({"items": [
            {"spec": {"replicas": 2}, "status": {"readyReplicas": 1}},
            {"spec": {}, "status": {}},
        ]});
        // An absent `replicas` counts as 1, an absent `readyReplicas` as 0.
        assert_eq!(read_deployments(&list), Fetch::Visible(counts(1, 3)));
        let none = json!({"items": [{"spec": {"replicas": 0}, "status": {}}]});
        assert_eq!(read_deployments(&none), Fetch::Visible(counts(0, 0)));
        assert_eq!(read_deployments(&json!({"items": []})), Fetch::NotFound);
    }

    fn outcomes() -> Outcomes {
        let lease = |state| {
            Fetch::Visible(LeaseReading {
                leader: Leader {
                    holder: "h".into(),
                    renewed: None,
                    lease_seconds: None,
                },
                state,
            })
        };
        Outcomes {
            etcd_check: Some(true),
            etcd_pods: Fetch::Visible(counts(1, 1)),
            scheduler_lease: lease(HealthState::Healthy),
            scheduler_pods: Fetch::Visible(counts(1, 1)),
            controller_manager_lease: lease(HealthState::Healthy),
            controller_manager_pods: Fetch::Visible(counts(1, 1)),
            dns: Fetch::Visible(counts(2, 2)),
            proxy: Fetch::Visible(counts(3, 3)),
        }
    }

    fn find<'a>(c: &'a [ControlPlaneComponent], id: &str) -> &'a ControlPlaneComponent {
        c.iter().find(|c| c.id == id).unwrap()
    }

    #[test]
    fn components_come_in_order_and_healthy() {
        let components = assemble(&outcomes());
        let ids: Vec<_> = components.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["etcd", "scheduler", "controller-manager", "dns", "proxy"]
        );
        let names: Vec<_> = components.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "etcd",
                "Scheduler",
                "Controller manager",
                "DNS",
                "kube-proxy"
            ]
        );
        assert!(components.iter().all(|c| c.state == HealthState::Healthy));
        assert_eq!(find(&components, "etcd").check, Some(true));
        assert_eq!(find(&components, "dns").check, None);
        assert!(find(&components, "scheduler").leader.is_some());
        assert!(find(&components, "dns").leader.is_none());
    }

    #[test]
    fn a_source_that_cannot_be_seen_is_null_and_nothing_seen_is_unknown() {
        let mut o = outcomes();
        o.etcd_check = None;
        o.etcd_pods = Fetch::Forbidden;
        o.scheduler_lease = Fetch::Forbidden;
        o.scheduler_pods = Fetch::NotFound;
        o.controller_manager_lease = Fetch::Failed;
        o.dns = Fetch::Failed;
        o.proxy = Fetch::Forbidden;
        let components = assemble(&o);
        for id in ["etcd", "scheduler", "controller-manager", "dns", "proxy"] {
            let c = find(&components, id);
            assert_eq!(
                c.state,
                if id == "controller-manager" {
                    HealthState::Healthy
                } else {
                    HealthState::Unknown
                },
                "{id}"
            );
            assert_eq!(c.leader, None, "{id}");
        }
        assert_eq!(find(&components, "etcd").pods, None);
        assert_eq!(find(&components, "etcd").check, None);
        assert_eq!(find(&components, "dns").pods, None);
        // Its Pods are visible, only the Lease is not.
        assert_eq!(
            find(&components, "controller-manager").pods,
            Some(counts(1, 1))
        );
    }

    #[test]
    fn kube_proxy_is_left_out_only_when_its_daemon_set_is_absent() {
        let mut o = outcomes();
        o.proxy = Fetch::NotFound;
        assert!(assemble(&o).iter().all(|c| c.id != "proxy"));
        o.proxy = Fetch::Forbidden;
        let components = assemble(&o);
        let proxy = find(&components, "proxy");
        assert_eq!((proxy.state, proxy.pods), (HealthState::Unknown, None));
        o.proxy = Fetch::Failed;
        assert_eq!(find(&assemble(&o), "proxy").state, HealthState::Unknown);
        o.proxy = Fetch::Visible(counts(0, 0));
        let components = assemble(&o);
        let proxy = find(&components, "proxy");
        assert_eq!(
            (proxy.state, proxy.pods),
            (HealthState::Unhealthy, Some(counts(0, 0)))
        );
    }

    #[test]
    fn the_worst_source_decides_a_component() {
        let mut o = outcomes();
        o.etcd_check = Some(false);
        let components = assemble(&o);
        let etcd = find(&components, "etcd");
        assert_eq!(
            (etcd.state, etcd.check),
            (HealthState::Unhealthy, Some(false))
        );
        let mut o = outcomes();
        o.scheduler_pods = Fetch::Visible(counts(1, 2));
        assert_eq!(
            find(&assemble(&o), "scheduler").state,
            HealthState::Degraded
        );
        let mut o = outcomes();
        o.controller_manager_lease = Fetch::Visible(LeaseReading {
            leader: Leader {
                holder: String::new(),
                renewed: None,
                lease_seconds: None,
            },
            state: HealthState::Unhealthy,
        });
        assert_eq!(
            find(&assemble(&o), "controller-manager").state,
            HealthState::Unhealthy
        );
    }

    #[test]
    fn statuses_become_fetch_outcomes() {
        let raw = |status: u16, body: &str| RawResponse {
            status: StatusCode::from_u16(status).unwrap(),
            body: body.as_bytes().to_vec(),
            date: None,
        };
        let pods = r#"{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}"#;
        assert_eq!(
            fetch_with(&raw(200, pods), read_pod_list),
            Fetch::Visible(counts(1, 1))
        );
        assert_eq!(fetch_with(&raw(401, ""), read_pod_list), Fetch::Forbidden);
        assert_eq!(fetch_with(&raw(403, ""), read_pod_list), Fetch::Forbidden);
        assert_eq!(fetch_with(&raw(404, ""), read_pod_list), Fetch::NotFound);
        assert_eq!(fetch_with(&raw(500, ""), read_pod_list), Fetch::Failed);
        assert_eq!(fetch_with(&raw(503, pods), read_pod_list), Fetch::Failed);
        assert_eq!(
            fetch_with(&raw(200, "<html>"), read_pod_list),
            Fetch::Failed
        );
    }

    #[test]
    fn version_needs_a_good_answer_with_a_git_version() {
        let raw = |status: u16, body: &str| RawResponse {
            status: StatusCode::from_u16(status).unwrap(),
            body: body.as_bytes().to_vec(),
            date: None,
        };
        let good = read_version(&raw(
            200,
            r#"{"gitVersion":"v1.37.0","platform":"linux/amd64","goVersion":"","buildDate":"2026-01-01T00:00:00Z"}"#,
        ))
        .unwrap();
        assert_eq!(good.version, "v1.37.0");
        assert_eq!(good.platform.as_deref(), Some("linux/amd64"));
        assert_eq!(good.go_version, None);
        assert_eq!(good.build_date.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert!(read_version(&raw(500, r#"{"gitVersion":"v1"}"#)).is_none());
        assert!(read_version(&raw(403, "")).is_none());
        assert!(read_version(&raw(200, "{}")).is_none());
        assert!(read_version(&raw(200, "nope")).is_none());
    }
}
