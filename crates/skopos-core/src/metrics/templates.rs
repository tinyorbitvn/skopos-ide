//! PromQL for each target (spec §5.4): our own templates over the standard names of cAdvisor,
//! kube-state-metrics and node exporter. Every selector is built by [`selector`], which adds
//! the cluster label when there is one (spec I11, I13).

use super::MetricName::{self, *};
use super::{LabelMatcher, MetricsRange};
const BUSY_CPU: &str = r#"mode!~"idle|iowait|steal""#;
/// Real containers. A pod's own cgroup and its sandbox carry no container name.
const CONTAINERS: &str = r#"container!="", container!="POD""#;
/// What RE2 reads as more than a literal character.
const REGEX_META: &str = r"\.+*?()|[]{}^$";

/// The span of a range query, in unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Window {
    pub(crate) start: i64,
    pub(crate) end: i64,
    pub(crate) step: i64,
}

impl MetricsRange {
    /// The length in seconds, and the step between points.
    fn seconds_and_step(self) -> (i64, i64) {
        match self {
            Self::OneHour => (3_600, 60),
            Self::SixHours => (21_600, 300),
            Self::OneDay => (86_400, 900),
            Self::SevenDays => (604_800, 3_600),
        }
    }

    /// The range ending at the last whole step before `now`, so a query repeated within one
    /// step asks for the same points.
    pub(crate) fn window(self, now: i64) -> Window {
        let (seconds, step) = self.seconds_and_step();
        let end = now - now.rem_euclid(step);
        Window {
            start: end - seconds,
            end,
            step,
        }
    }
}

/// `max(2m, step)`.
pub(crate) fn rate_window(step: i64) -> String {
    format!("{}s", step.max(120))
}

/// A PromQL string literal.
pub(crate) fn quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for c in text.chars() {
        match c {
            '\\' => quoted.push_str(r"\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str(r"\n"),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// A regular expression that matches `text` and nothing else.
pub(crate) fn escape_regex(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        if REGEX_META.contains(c) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// What a target covers, with a workload's pods already listed.
pub(crate) enum Scope<'a> {
    Cluster,
    /// The API server's own metrics, and etcd as the API server sees it.
    ControlPlane,
    Node(&'a str),
    /// One pod, or a workload's pods. Never empty.
    Pods {
        namespace: &'a str,
        pods: &'a [String],
    },
    Pvc {
        namespace: &'a str,
        name: &'a str,
    },
}

/// The target's metrics in the contract's order, each with its query. `extra` is the
/// cluster label every selector also matches.
pub(crate) fn queries(
    scope: &Scope<'_>,
    step: i64,
    extra: Option<&LabelMatcher>,
) -> Vec<(MetricName, String)> {
    let window = rate_window(step);
    match scope {
        Scope::Cluster => machines(None, &window, extra),
        Scope::ControlPlane => control_plane(&window, extra),
        Scope::Node(name) => machines(Some(*name), &window, extra),
        Scope::Pods { namespace, pods } => pods_of(namespace, pods, &window, extra),
        Scope::Pvc { namespace, name } => volume(namespace, name, extra),
    }
}

/// `name="value"`, the value quoted as a PromQL string (spec I12).
fn label_matcher(matcher: &LabelMatcher) -> String {
    format!("{}={}", matcher.name, quote(&matcher.value))
}

/// `metric{matchers}`, with the cluster label after the selector's own matchers. The only
/// place a selector is written.
fn selector(metric: &str, matchers: &[String], extra: Option<&LabelMatcher>) -> String {
    let mut all = matchers.to_vec();
    if let Some(extra) = extra {
        all.push(label_matcher(extra));
    }
    if all.is_empty() {
        metric.to_owned()
    } else {
        format!("{metric}{{{}}}", all.join(", "))
    }
}

/// What the probe asks: `up`, or `up{‹label›}` (spec I15).
pub(crate) fn up_query(extra: Option<&LabelMatcher>) -> String {
    selector("up", &[], extra)
}

/// A pod counts while it is Pending or Running; completed pods keep their series.
fn active(extra: Option<&LabelMatcher>) -> String {
    format!(
        "max by (namespace, pod) ({})",
        selector(
            "kube_pod_status_phase",
            &[r#"phase=~"Pending|Running""#.to_owned()],
            extra
        )
    )
}

/// The sum over pods that are Pending or Running.
fn of_active(series: &str, extra: Option<&LabelMatcher>) -> String {
    format!(
        "sum({series} * on(namespace, pod) group_left() {})",
        active(extra)
    )
}

/// A node exporter expression summed over the cluster, or over the one node whose
/// `node_uname_info` names it, whatever the scrape put in `instance`.
fn on_node(expr: &str, node: Option<&str>, extra: Option<&LabelMatcher>) -> String {
    match node {
        None => format!("sum({expr})"),
        Some(node) => format!(
            "sum(({expr}) * on(instance) group_left() max by (instance) ({}))",
            selector(
                "node_uname_info",
                &[format!("nodename={}", quote(node))],
                extra
            )
        ),
    }
}

/// Each node's root filesystem: `/`, or `/var` on a node without `/` among its mounts, as on
/// kind's nodes.
fn root_disk(used: bool, extra: Option<&LabelMatcher>) -> String {
    let mount = |mountpoint: &str| {
        let matchers = [format!("mountpoint={}", quote(mountpoint))];
        let size = selector("node_filesystem_size_bytes", &matchers, extra);
        if used {
            format!(
                "{size} - {}",
                selector("node_filesystem_avail_bytes", &matchers, extra)
            )
        } else {
            size
        }
    };
    format!(
        "max by (instance) ({}) or max by (instance) ({})",
        mount("/"),
        mount("/var")
    )
}

/// The cluster's nodes, or one node.
fn machines(
    node: Option<&str>,
    window: &str,
    extra: Option<&LabelMatcher>,
) -> Vec<(MetricName, String)> {
    let state = |metric: &str, resource: Option<&str>| {
        let mut matchers = Vec::new();
        if let Some(resource) = resource {
            matchers.push(format!("resource={}", quote(resource)));
        }
        if let Some(node) = node {
            matchers.push(format!("node={}", quote(node)));
        }
        selector(metric, &matchers, extra)
    };
    let requests = |resource: &str| {
        of_active(
            &state("kube_pod_container_resource_requests", Some(resource)),
            extra,
        )
    };
    let limits = |resource: &str| {
        of_active(
            &state("kube_pod_container_resource_limits", Some(resource)),
            extra,
        )
    };
    let allocatable = |resource: &str| {
        format!(
            "sum({})",
            state("kube_node_status_allocatable", Some(resource))
        )
    };
    let capacity = |resource: &str| {
        format!(
            "sum({})",
            state("kube_node_status_capacity", Some(resource))
        )
    };
    let cpu = format!(
        "rate({}[{window}])",
        selector("node_cpu_seconds_total", &[BUSY_CPU.to_owned()], extra)
    );
    let memory = format!(
        "{} - {}",
        selector("node_memory_MemTotal_bytes", &[], extra),
        selector("node_memory_MemAvailable_bytes", &[], extra)
    );
    vec![
        (CpuUsage, on_node(&cpu, node, extra)),
        (CpuRequests, requests("cpu")),
        (CpuLimits, limits("cpu")),
        (CpuAllocatable, allocatable("cpu")),
        (CpuCapacity, capacity("cpu")),
        (MemoryUsage, on_node(&memory, node, extra)),
        (MemoryRequests, requests("memory")),
        (MemoryLimits, limits("memory")),
        (MemoryAllocatable, allocatable("memory")),
        (MemoryCapacity, capacity("memory")),
        (PodUsage, of_active(&state("kube_pod_info", None), extra)),
        (PodAllocatable, allocatable("pods")),
        (PodCapacity, capacity("pods")),
        (DiskUsage, on_node(&root_disk(true, extra), node, extra)),
        (DiskCapacity, on_node(&root_disk(false, extra), node, extra)),
    ]
}

/// One pod, or a workload's pods.
fn pods_of(
    namespace: &str,
    pods: &[String],
    window: &str,
    extra: Option<&LabelMatcher>,
) -> Vec<(MetricName, String)> {
    let pod = match pods {
        [one] => format!("pod={}", quote(one)),
        many => {
            let names: Vec<String> = many.iter().map(String::as_str).map(escape_regex).collect();
            format!("pod=~{}", quote(&format!("^(?:{})$", names.join("|"))))
        }
    };
    let all = vec![format!("namespace={}", quote(namespace)), pod];
    let containers = [all.clone(), vec![CONTAINERS.to_owned()]].concat();
    let rate = |metric: &str, matchers: &[String]| {
        format!("sum(rate({}[{window}]))", selector(metric, matchers, extra))
    };
    let sum =
        |metric: &str, matchers: &[String]| format!("sum({})", selector(metric, matchers, extra));
    let resource = |metric: &str, resource: &str| {
        let matchers = [all.clone(), vec![format!("resource={}", quote(resource))]].concat();
        of_active(&selector(metric, &matchers, extra), extra)
    };
    vec![
        (
            CpuUsage,
            rate("container_cpu_usage_seconds_total", &containers),
        ),
        (
            CpuRequests,
            resource("kube_pod_container_resource_requests", "cpu"),
        ),
        (
            CpuLimits,
            resource("kube_pod_container_resource_limits", "cpu"),
        ),
        (
            MemoryUsage,
            sum("container_memory_working_set_bytes", &containers),
        ),
        (
            MemoryRequests,
            resource("kube_pod_container_resource_requests", "memory"),
        ),
        (
            MemoryLimits,
            resource("kube_pod_container_resource_limits", "memory"),
        ),
        // Only the pod's sandbox counts network traffic, and it has no container name.
        (
            NetworkReceive,
            rate("container_network_receive_bytes_total", &all),
        ),
        (
            NetworkTransmit,
            rate("container_network_transmit_bytes_total", &all),
        ),
        (FsReads, rate("container_fs_reads_bytes_total", &containers)),
        (
            FsWrites,
            rate("container_fs_writes_bytes_total", &containers),
        ),
        (FsUsage, sum("container_fs_usage_bytes", &containers)),
    ]
}

/// A PersistentVolumeClaim, from the kubelet of each node that mounts it. A volume mounted on
/// two nodes is reported twice, so the larger value counts.
fn volume(namespace: &str, name: &str, extra: Option<&LabelMatcher>) -> Vec<(MetricName, String)> {
    let matchers = [
        format!("namespace={}", quote(namespace)),
        format!("persistentvolumeclaim={}", quote(name)),
    ];
    vec![
        (
            DiskUsage,
            format!(
                "max({})",
                selector("kubelet_volume_stats_used_bytes", &matchers, extra)
            ),
        ),
        (
            DiskCapacity,
            format!(
                "max({})",
                selector("kubelet_volume_stats_capacity_bytes", &matchers, extra)
            ),
        ),
    ]
}

/// The control plane, from the API server's own metrics: a managed cluster, whose etcd nobody
/// scrapes, has them too. The database size reads `apiserver_storage_size_bytes`, and falls
/// back to the deprecated `etcd_db_total_size_in_bytes` that older clusters still export.
fn control_plane(window: &str, extra: Option<&LabelMatcher>) -> Vec<(MetricName, String)> {
    let requests = |matchers: &[String]| {
        format!(
            "sum(rate({}[{window}]))",
            selector("apiserver_request_total", matchers, extra)
        )
    };
    let p99 = |metric: &str, matchers: &[String]| {
        format!(
            "histogram_quantile(0.99, sum by (le) (rate({}[{window}])))",
            selector(metric, matchers, extra)
        )
    };
    vec![
        (ApiRequests, requests(&[])),
        (ApiErrors, requests(&[r#"code=~"5..""#.to_owned()])),
        (
            ApiLatencyP99,
            p99(
                "apiserver_request_duration_seconds_bucket",
                &[r#"verb!~"WATCH|CONNECT""#.to_owned()],
            ),
        ),
        (
            EtcdLatencyP99,
            p99("etcd_request_duration_seconds_bucket", &[]),
        ),
        (
            EtcdDbSize,
            format!(
                "max({}) or max({})",
                selector("apiserver_storage_size_bytes", &[], extra),
                selector("etcd_db_total_size_in_bytes", &[], extra)
            ),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    use promql_parser::label::MatchOp;
    use promql_parser::parser::{self, Expr, VectorSelector};
    use promql_parser::util::{walk_expr, ExprVisitor};

    fn query(scope: &Scope<'_>, step: i64, name: MetricName) -> String {
        matched(scope, step, name, None)
    }

    fn matched(
        scope: &Scope<'_>,
        step: i64,
        name: MetricName,
        extra: Option<&LabelMatcher>,
    ) -> String {
        queries(scope, step, extra)
            .into_iter()
            .find(|(metric, _)| *metric == name)
            .map(|(_, query)| query)
            .unwrap()
    }

    fn names(scope: Scope<'_>) -> Vec<MetricName> {
        queries(&scope, 60, None)
            .into_iter()
            .map(|(name, _)| name)
            .collect()
    }

    fn cluster_label(value: &str) -> LabelMatcher {
        LabelMatcher {
            name: "cluster".to_owned(),
            value: value.to_owned(),
        }
    }

    /// Every query of every scope of I11 and I14 at each range's step, as
    /// (`scope step metric`, query).
    fn query_set(extra: Option<&LabelMatcher>) -> Vec<(String, String)> {
        let one = ["web-1".to_owned()];
        let two = ["web-7d9f-abcde".to_owned(), "web-7d9f-fghij".to_owned()];
        let scopes = [
            ("cluster", Scope::Cluster),
            ("node", Scope::Node("ip-10-0-0-1.ec2.internal")),
            (
                "pod",
                Scope::Pods {
                    namespace: "shop",
                    pods: &one,
                },
            ),
            (
                "pods",
                Scope::Pods {
                    namespace: "shop",
                    pods: &two,
                },
            ),
            (
                "pvc",
                Scope::Pvc {
                    namespace: "shop",
                    name: "data",
                },
            ),
        ];
        let mut set = Vec::new();
        for (name, scope) in &scopes {
            for step in [60, 300, 900, 3_600] {
                for (metric, query) in queries(scope, step, extra) {
                    set.push((format!("{name} {step} {metric:?}"), query));
                }
            }
        }
        set
    }

    /// Counts the vector selectors of a query, and names those that do not hold `extra`
    /// exactly once.
    struct Selectors<'a> {
        extra: &'a LabelMatcher,
        seen: usize,
        wrong: Vec<String>,
    }

    impl Selectors<'_> {
        fn check(&mut self, selector: &VectorSelector) {
            self.seen += 1;
            let held = selector
                .matchers
                .matchers
                .iter()
                .filter(|m| {
                    m.name == self.extra.name
                        && m.value == self.extra.value
                        && matches!(m.op, MatchOp::Equal)
                })
                .count();
            if held != 1 || !selector.matchers.or_matchers.is_empty() {
                self.wrong.push(format!("{:?}", selector.name));
            }
        }
    }

    impl ExprVisitor for Selectors<'_> {
        type Error = String;

        fn pre_visit(&mut self, expr: &Expr) -> Result<bool, Self::Error> {
            match expr {
                Expr::VectorSelector(selector) => self.check(selector),
                // walk_expr stops at a range selector, so its vector selector is read here.
                Expr::MatrixSelector(range) => self.check(&range.vs),
                _ => {}
            }
            Ok(true)
        }
    }

    /// (selectors seen, selectors without `extra` exactly once) of a parsed query.
    fn selectors(extra: &LabelMatcher, query: &str) -> (usize, Vec<String>) {
        let expr = parser::parse(query).unwrap_or_else(|e| panic!("{query}: {e:?}"));
        let mut visitor = Selectors {
            extra,
            seen: 0,
            wrong: Vec::new(),
        };
        walk_expr(&mut visitor, &expr).unwrap();
        (visitor.seen, visitor.wrong)
    }

    #[test]
    fn windows_end_on_a_whole_step_and_span_the_range() {
        let window = |start, end, step| Window { start, end, step };
        assert_eq!(
            MetricsRange::OneHour.window(1_000_030),
            window(996_420, 1_000_020, 60)
        );
        assert_eq!(
            MetricsRange::SixHours.window(1_000_030),
            window(978_300, 999_900, 300)
        );
        assert_eq!(
            MetricsRange::OneDay.window(1_000_030),
            window(913_500, 999_900, 900)
        );
        assert_eq!(
            MetricsRange::SevenDays.window(1_000_030),
            window(392_400, 997_200, 3_600)
        );
        // Asked again within the same step, the same points.
        assert_eq!(
            MetricsRange::OneHour.window(1_000_079),
            MetricsRange::OneHour.window(1_000_020)
        );
    }

    #[test]
    fn rate_windows_are_at_least_two_minutes() {
        assert_eq!(rate_window(60), "120s");
        assert_eq!(rate_window(300), "300s");
        assert_eq!(rate_window(3_600), "3600s");
    }

    #[test]
    fn names_are_quoted_and_escaped() {
        assert_eq!(quote("web"), r#""web""#);
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(
            escape_regex("ip-10-0-0-1.ec2.internal"),
            r"ip-10-0-0-1\.ec2\.internal"
        );
        assert_eq!(
            escape_regex("a+b(c)|[d]{e}^$*?"),
            r"a\+b\(c\)\|\[d\]\{e\}\^\$\*\?"
        );
        let node = query(&Scope::Node("ip-10.internal"), 60, MetricName::PodCapacity);
        assert!(node.contains(r#"node="ip-10.internal""#), "{node}");
        let pods = ["a.b".to_owned(), "c".to_owned()];
        let cpu = query(
            &Scope::Pods {
                namespace: "shop",
                pods: &pods,
            },
            60,
            MetricName::CpuUsage,
        );
        assert!(cpu.contains(r#"pod=~"^(?:a\\.b|c)$""#), "{cpu}");
    }

    #[test]
    fn each_target_asks_for_the_contract_metrics() {
        let machine = [
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
        ];
        assert_eq!(names(Scope::Cluster), machine);
        assert_eq!(names(Scope::Node("n")), machine);
        assert_eq!(
            names(Scope::ControlPlane),
            [
                ApiRequests,
                ApiErrors,
                ApiLatencyP99,
                EtcdLatencyP99,
                EtcdDbSize
            ]
        );
        let pods = ["p".to_owned()];
        assert_eq!(
            names(Scope::Pods {
                namespace: "ns",
                pods: &pods
            }),
            [
                CpuUsage,
                CpuRequests,
                CpuLimits,
                MemoryUsage,
                MemoryRequests,
                MemoryLimits,
                NetworkReceive,
                NetworkTransmit,
                FsReads,
                FsWrites,
                FsUsage,
            ]
        );
        assert_eq!(
            names(Scope::Pvc {
                namespace: "ns",
                name: "data"
            }),
            [DiskUsage, DiskCapacity]
        );
    }

    #[test]
    fn the_cluster_sums_every_node() {
        let cluster = |name| query(&Scope::Cluster, 60, name);
        assert_eq!(
            cluster(CpuUsage),
            r#"sum(rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[120s]))"#
        );
        assert_eq!(
            cluster(MemoryUsage),
            "sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)"
        );
        assert_eq!(
            cluster(DiskCapacity),
            r#"sum(max by (instance) (node_filesystem_size_bytes{mountpoint="/"}) or max by (instance) (node_filesystem_size_bytes{mountpoint="/var"}))"#
        );
        assert_eq!(
            cluster(DiskUsage),
            r#"sum(max by (instance) (node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"}) or max by (instance) (node_filesystem_size_bytes{mountpoint="/var"} - node_filesystem_avail_bytes{mountpoint="/var"}))"#
        );
        assert_eq!(
            cluster(PodUsage),
            r#"sum(kube_pod_info * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            cluster(MemoryLimits),
            r#"sum(kube_pod_container_resource_limits{resource="memory"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            cluster(CpuAllocatable),
            r#"sum(kube_node_status_allocatable{resource="cpu"})"#
        );
        assert_eq!(
            cluster(PodCapacity),
            r#"sum(kube_node_status_capacity{resource="pods"})"#
        );
    }

    #[test]
    fn a_node_joins_node_exporter_by_instance_and_filters_kube_state_metrics_by_node() {
        let node = |name| query(&Scope::Node("worker"), 60, name);
        assert_eq!(
            node(CpuUsage),
            r#"sum((rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[120s])) * on(instance) group_left() max by (instance) (node_uname_info{nodename="worker"}))"#
        );
        assert_eq!(
            node(DiskCapacity),
            r#"sum((max by (instance) (node_filesystem_size_bytes{mountpoint="/"}) or max by (instance) (node_filesystem_size_bytes{mountpoint="/var"})) * on(instance) group_left() max by (instance) (node_uname_info{nodename="worker"}))"#
        );
        assert_eq!(
            node(CpuRequests),
            r#"sum(kube_pod_container_resource_requests{resource="cpu", node="worker"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            node(PodUsage),
            r#"sum(kube_pod_info{node="worker"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            node(MemoryAllocatable),
            r#"sum(kube_node_status_allocatable{resource="memory", node="worker"})"#
        );
    }

    #[test]
    fn pods_count_containers_only_except_for_network() {
        let pods = ["web-1".to_owned()];
        let pod = |name| {
            query(
                &Scope::Pods {
                    namespace: "shop",
                    pods: &pods,
                },
                300,
                name,
            )
        };
        assert_eq!(
            pod(CpuUsage),
            r#"sum(rate(container_cpu_usage_seconds_total{namespace="shop", pod="web-1", container!="", container!="POD"}[300s]))"#
        );
        assert_eq!(
            pod(MemoryUsage),
            r#"sum(container_memory_working_set_bytes{namespace="shop", pod="web-1", container!="", container!="POD"})"#
        );
        assert_eq!(
            pod(CpuLimits),
            r#"sum(kube_pod_container_resource_limits{namespace="shop", pod="web-1", resource="cpu"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            pod(NetworkTransmit),
            r#"sum(rate(container_network_transmit_bytes_total{namespace="shop", pod="web-1"}[300s]))"#
        );
        assert_eq!(
            pod(FsWrites),
            r#"sum(rate(container_fs_writes_bytes_total{namespace="shop", pod="web-1", container!="", container!="POD"}[300s]))"#
        );
        assert_eq!(
            pod(FsUsage),
            r#"sum(container_fs_usage_bytes{namespace="shop", pod="web-1", container!="", container!="POD"})"#
        );
    }

    #[test]
    fn a_workload_matches_its_pods_by_an_anchored_alternation() {
        let pods = ["web-7d9f-abcde".to_owned(), "web-7d9f-fghij".to_owned()];
        let memory = query(
            &Scope::Pods {
                namespace: "shop",
                pods: &pods,
            },
            60,
            MemoryRequests,
        );
        assert_eq!(
            memory,
            r#"sum(kube_pod_container_resource_requests{namespace="shop", pod=~"^(?:web-7d9f-abcde|web-7d9f-fghij)$", resource="memory"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
    }

    #[test]
    fn a_pvc_reads_the_kubelet_volume_stats() {
        let pvc = |name| {
            query(
                &Scope::Pvc {
                    namespace: "shop",
                    name: "data",
                },
                60,
                name,
            )
        };
        assert_eq!(
            pvc(DiskUsage),
            r#"max(kubelet_volume_stats_used_bytes{namespace="shop", persistentvolumeclaim="data"})"#
        );
        assert_eq!(
            pvc(DiskCapacity),
            r#"max(kubelet_volume_stats_capacity_bytes{namespace="shop", persistentvolumeclaim="data"})"#
        );
    }

    #[test]
    fn without_a_matcher_every_query_is_the_one_0_5_0_sent() {
        let now: Vec<String> = query_set(None)
            .into_iter()
            .map(|(at, query)| format!("{at} {query}"))
            .collect();
        let golden: Vec<&str> = include_str!("testdata/queries-0.5.0.txt").lines().collect();
        assert_eq!(now, golden);
    }

    #[test]
    fn with_a_matcher_every_selector_of_every_query_holds_it_once() {
        // A value PromQL must escape: quotes and a backslash.
        let extra = cluster_label(r#"eu "west" \1"#);
        let set = query_set(Some(&extra));
        assert_eq!(set.len(), 216);
        for (at, query) in &set {
            let (seen, wrong) = selectors(&extra, query);
            assert!(seen > 0, "{at}: {query}");
            assert!(wrong.is_empty(), "{at}: {query}: {wrong:?}");
        }
        assert_eq!(
            selectors(&extra, &up_query(Some(&extra))),
            (1, Vec::<String>::new())
        );
    }

    #[test]
    fn the_matcher_is_name_equals_the_quoted_value_after_the_selectors_own() {
        let tricky = cluster_label(r#"eu "west" \1"#);
        assert_eq!(label_matcher(&tricky), r#"cluster="eu \"west\" \\1""#);
        assert_eq!(up_query(None), "up");
        assert_eq!(up_query(Some(&tricky)), r#"up{cluster="eu \"west\" \\1"}"#);

        let prod = cluster_label("prod");
        assert_eq!(
            matched(&Scope::Cluster, 60, CpuUsage, Some(&prod)),
            r#"sum(rate(node_cpu_seconds_total{mode!~"idle|iowait|steal", cluster="prod"}[120s]))"#
        );
        assert_eq!(
            matched(&Scope::Cluster, 60, MemoryUsage, Some(&prod)),
            r#"sum(node_memory_MemTotal_bytes{cluster="prod"} - node_memory_MemAvailable_bytes{cluster="prod"})"#
        );
        assert_eq!(
            matched(&Scope::Cluster, 60, PodUsage, Some(&prod)),
            r#"sum(kube_pod_info{cluster="prod"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running", cluster="prod"}))"#
        );
        assert_eq!(
            matched(&Scope::Node("worker"), 60, CpuUsage, Some(&prod)),
            r#"sum((rate(node_cpu_seconds_total{mode!~"idle|iowait|steal", cluster="prod"}[120s])) * on(instance) group_left() max by (instance) (node_uname_info{nodename="worker", cluster="prod"}))"#
        );
        assert_eq!(
            matched(
                &Scope::Pvc {
                    namespace: "shop",
                    name: "data"
                },
                60,
                DiskUsage,
                Some(&prod)
            ),
            r#"max(kubelet_volume_stats_used_bytes{namespace="shop", persistentvolumeclaim="data", cluster="prod"})"#
        );
    }

    #[test]
    fn the_control_plane_reads_the_api_servers_own_metrics() {
        let at = |name| query(&Scope::ControlPlane, 60, name);
        assert_eq!(at(ApiRequests), "sum(rate(apiserver_request_total[120s]))");
        assert_eq!(
            at(ApiErrors),
            r#"sum(rate(apiserver_request_total{code=~"5.."}[120s]))"#
        );
        assert_eq!(
            at(ApiLatencyP99),
            r#"histogram_quantile(0.99, sum by (le) (rate(apiserver_request_duration_seconds_bucket{verb!~"WATCH|CONNECT"}[120s])))"#
        );
        assert_eq!(
            at(EtcdLatencyP99),
            "histogram_quantile(0.99, sum by (le) (rate(etcd_request_duration_seconds_bucket[120s])))"
        );
        // apiserver_storage_size_bytes replaces the deprecated etcd_db_total_size_in_bytes.
        assert_eq!(
            at(EtcdDbSize),
            "max(apiserver_storage_size_bytes) or max(etcd_db_total_size_in_bytes)"
        );
        // The rate window follows the step, as for CPU.
        assert_eq!(
            query(&Scope::ControlPlane, 3_600, ApiRequests),
            "sum(rate(apiserver_request_total[3600s]))"
        );

        let prod = cluster_label("prod");
        assert_eq!(
            matched(&Scope::ControlPlane, 60, ApiErrors, Some(&prod)),
            r#"sum(rate(apiserver_request_total{code=~"5..", cluster="prod"}[120s]))"#
        );
        assert_eq!(
            matched(&Scope::ControlPlane, 60, EtcdDbSize, Some(&prod)),
            r#"max(apiserver_storage_size_bytes{cluster="prod"}) or max(etcd_db_total_size_in_bytes{cluster="prod"})"#
        );
    }

    #[test]
    fn with_a_matcher_every_control_plane_selector_holds_it_once() {
        let extra = cluster_label(r#"eu "west" \1"#);
        for step in [60, 300, 900, 3_600] {
            for (metric, query) in queries(&Scope::ControlPlane, step, Some(&extra)) {
                let (seen, wrong) = selectors(&extra, &query);
                assert!(seen > 0, "{step} {metric:?}: {query}");
                assert!(wrong.is_empty(), "{step} {metric:?}: {query}: {wrong:?}");
            }
        }
    }

    #[test]
    fn the_control_plane_queries_are_the_golden_ones() {
        let mut now = Vec::new();
        for step in [60, 300, 900, 3_600] {
            for (metric, query) in queries(&Scope::ControlPlane, step, None) {
                now.push(format!("controlPlane {step} {metric:?} {query}"));
            }
        }
        let golden: Vec<&str> = include_str!("testdata/queries-control-plane.txt")
            .lines()
            .collect();
        assert_eq!(now, golden);
    }
}
