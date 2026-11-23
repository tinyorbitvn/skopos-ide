//! The kinds the graph reads (spec E §4.2, O §4.1, network policies spec §7.2), and where each
//! one is listed.

use kube::Discovery;

use crate::resources::ResourceRef;

pub(crate) const GATEWAY_GROUP: &str = "gateway.networking.k8s.io";
pub(crate) const RBAC_GROUP: &str = "rbac.authorization.k8s.io";
pub(crate) const CILIUM_GROUP: &str = "cilium.io";
pub(crate) const ARGO_GROUP: &str = "argoproj.io";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Kind {
    Pod,
    Service,
    Deployment,
    ReplicaSet,
    StatefulSet,
    DaemonSet,
    Job,
    CronJob,
    Ingress,
    ConfigMap,
    Secret,
    ServiceAccount,
    PersistentVolumeClaim,
    GatewayClass,
    Gateway,
    HttpRoute,
    Role,
    RoleBinding,
    ClusterRole,
    ClusterRoleBinding,
    /// Read for its labels, which policies select namespaces by. Never a node.
    Namespace,
    NetworkPolicy,
    CiliumNetworkPolicy,
    CiliumClusterwideNetworkPolicy,
    Application,
    ApplicationSet,
    AppProject,
}

impl Kind {
    pub(crate) const ALL: [Kind; 27] = [
        Kind::Pod,
        Kind::Service,
        Kind::Deployment,
        Kind::ReplicaSet,
        Kind::StatefulSet,
        Kind::DaemonSet,
        Kind::Job,
        Kind::CronJob,
        Kind::Ingress,
        Kind::ConfigMap,
        Kind::Secret,
        Kind::ServiceAccount,
        Kind::PersistentVolumeClaim,
        Kind::GatewayClass,
        Kind::Gateway,
        Kind::HttpRoute,
        Kind::Role,
        Kind::RoleBinding,
        Kind::ClusterRole,
        Kind::ClusterRoleBinding,
        Kind::Namespace,
        Kind::NetworkPolicy,
        Kind::CiliumNetworkPolicy,
        Kind::CiliumClusterwideNetworkPolicy,
        Kind::Application,
        Kind::ApplicationSet,
        Kind::AppProject,
    ];

    /// The Kubernetes kind, as node ids and owner references spell it.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Kind::Pod => "Pod",
            Kind::Service => "Service",
            Kind::Deployment => "Deployment",
            Kind::ReplicaSet => "ReplicaSet",
            Kind::StatefulSet => "StatefulSet",
            Kind::DaemonSet => "DaemonSet",
            Kind::Job => "Job",
            Kind::CronJob => "CronJob",
            Kind::Ingress => "Ingress",
            Kind::ConfigMap => "ConfigMap",
            Kind::Secret => "Secret",
            Kind::ServiceAccount => "ServiceAccount",
            Kind::PersistentVolumeClaim => "PersistentVolumeClaim",
            Kind::GatewayClass => "GatewayClass",
            Kind::Gateway => "Gateway",
            Kind::HttpRoute => "HTTPRoute",
            Kind::Role => "Role",
            Kind::RoleBinding => "RoleBinding",
            Kind::ClusterRole => "ClusterRole",
            Kind::ClusterRoleBinding => "ClusterRoleBinding",
            Kind::Namespace => "Namespace",
            Kind::NetworkPolicy => "NetworkPolicy",
            Kind::CiliumNetworkPolicy => "CiliumNetworkPolicy",
            Kind::CiliumClusterwideNetworkPolicy => "CiliumClusterwideNetworkPolicy",
            Kind::Application => "Application",
            Kind::ApplicationSet => "ApplicationSet",
            Kind::AppProject => "AppProject",
        }
    }

    pub(crate) fn group(self) -> &'static str {
        match self {
            Kind::Deployment | Kind::ReplicaSet | Kind::StatefulSet | Kind::DaemonSet => "apps",
            Kind::Job | Kind::CronJob => "batch",
            Kind::Ingress | Kind::NetworkPolicy => "networking.k8s.io",
            Kind::GatewayClass | Kind::Gateway | Kind::HttpRoute => GATEWAY_GROUP,
            Kind::Role | Kind::RoleBinding | Kind::ClusterRole | Kind::ClusterRoleBinding => {
                RBAC_GROUP
            }
            Kind::CiliumNetworkPolicy | Kind::CiliumClusterwideNetworkPolicy => CILIUM_GROUP,
            Kind::Application | Kind::ApplicationSet | Kind::AppProject => ARGO_GROUP,
            _ => "",
        }
    }

    /// The version the graph lists (network policies spec §2): `v2` for the Cilium kinds,
    /// `v1alpha1` for the Argo CD kinds, `v1` for every other.
    pub(crate) fn version(self) -> &'static str {
        match self.group() {
            CILIUM_GROUP => "v2",
            ARGO_GROUP => "v1alpha1",
            _ => "v1",
        }
    }

    pub(crate) fn plural(self) -> &'static str {
        match self {
            Kind::Pod => "pods",
            Kind::Service => "services",
            Kind::Deployment => "deployments",
            Kind::ReplicaSet => "replicasets",
            Kind::StatefulSet => "statefulsets",
            Kind::DaemonSet => "daemonsets",
            Kind::Job => "jobs",
            Kind::CronJob => "cronjobs",
            Kind::Ingress => "ingresses",
            Kind::ConfigMap => "configmaps",
            Kind::Secret => "secrets",
            Kind::ServiceAccount => "serviceaccounts",
            Kind::PersistentVolumeClaim => "persistentvolumeclaims",
            Kind::GatewayClass => "gatewayclasses",
            Kind::Gateway => "gateways",
            Kind::HttpRoute => "httproutes",
            Kind::Role => "roles",
            Kind::RoleBinding => "rolebindings",
            Kind::ClusterRole => "clusterroles",
            Kind::ClusterRoleBinding => "clusterrolebindings",
            Kind::Namespace => "namespaces",
            Kind::NetworkPolicy => "networkpolicies",
            Kind::CiliumNetworkPolicy => "ciliumnetworkpolicies",
            Kind::CiliumClusterwideNetworkPolicy => "ciliumclusterwidenetworkpolicies",
            Kind::Application => "applications",
            Kind::ApplicationSet => "applicationsets",
            Kind::AppProject => "appprojects",
        }
    }

    pub(crate) fn namespaced(self) -> bool {
        !matches!(
            self,
            Kind::GatewayClass
                | Kind::ClusterRole
                | Kind::ClusterRoleBinding
                | Kind::Namespace
                | Kind::CiliumClusterwideNetworkPolicy
        )
    }

    /// Becomes a node only when an edge points at it (spec E §4.4).
    pub(crate) fn is_leaf(self) -> bool {
        matches!(
            self,
            Kind::ConfigMap | Kind::Secret | Kind::ServiceAccount | Kind::PersistentVolumeClaim
        )
    }

    pub(crate) fn is_gateway_api(self) -> bool {
        self.group() == GATEWAY_GROUP
    }

    /// A binding or a role. It is not a leaf, but becomes a node only on the access chain of a
    /// ServiceAccount node (spec O §4.3).
    pub(crate) fn is_access(self) -> bool {
        self.group() == RBAC_GROUP
    }

    /// A NetworkPolicy or a Cilium policy: a node with `selects` edges to the Pods its rules
    /// select (network policies spec §3.3).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn is_policy(self) -> bool {
        matches!(
            self,
            Kind::NetworkPolicy | Kind::CiliumNetworkPolicy | Kind::CiliumClusterwideNetworkPolicy
        )
    }

    /// The kind of an API group and kind, as Argo CD's `status.resources` writes them, the
    /// core group being "". `None` for a kind the graph does not read.
    pub(crate) fn from_group_kind(group: &str, kind: &str) -> Option<Kind> {
        Kind::ALL
            .into_iter()
            .find(|candidate| candidate.group() == group && candidate.name() == kind)
    }

    /// The resource the watch hub lists, at the kind's version.
    pub(crate) fn resource(self) -> ResourceRef {
        ResourceRef {
            group: self.group().to_owned(),
            version: self.version().to_owned(),
            plural: self.plural().to_owned(),
            kind: self.name().to_owned(),
            namespaced: self.namespaced(),
        }
    }
}

/// The kinds the cluster serves, each at its own version, in `Kind::ALL` order. A kind it does
/// not serve is not read and is not reported missing (spec E §4.2, network policies spec §8).
pub(crate) fn served_kinds(discovery: &Discovery) -> Vec<Kind> {
    Kind::ALL
        .into_iter()
        .filter(|kind| {
            discovery.get(kind.group()).is_some_and(|group| {
                group
                    .versioned_resources(kind.version())
                    .iter()
                    .any(|(resource, _)| resource.plural == kind.plural())
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use kube::config::{KubeConfigOptions, Kubeconfig};
    use kube::{Client, Config};
    use skopos_fakekube::{FakeKube, FakeKubeConfig, FakeResource};

    use super::*;

    #[test]
    fn every_kind_names_its_list() {
        let table: Vec<_> = Kind::ALL
            .iter()
            .map(|k| (k.name(), k.group(), k.plural(), k.namespaced(), k.is_leaf()))
            .collect();
        assert_eq!(
            table,
            [
                ("Pod", "", "pods", true, false),
                ("Service", "", "services", true, false),
                ("Deployment", "apps", "deployments", true, false),
                ("ReplicaSet", "apps", "replicasets", true, false),
                ("StatefulSet", "apps", "statefulsets", true, false),
                ("DaemonSet", "apps", "daemonsets", true, false),
                ("Job", "batch", "jobs", true, false),
                ("CronJob", "batch", "cronjobs", true, false),
                ("Ingress", "networking.k8s.io", "ingresses", true, false),
                ("ConfigMap", "", "configmaps", true, true),
                ("Secret", "", "secrets", true, true),
                ("ServiceAccount", "", "serviceaccounts", true, true),
                (
                    "PersistentVolumeClaim",
                    "",
                    "persistentvolumeclaims",
                    true,
                    true
                ),
                (
                    "GatewayClass",
                    GATEWAY_GROUP,
                    "gatewayclasses",
                    false,
                    false
                ),
                ("Gateway", GATEWAY_GROUP, "gateways", true, false),
                ("HTTPRoute", GATEWAY_GROUP, "httproutes", true, false),
                ("Role", RBAC_GROUP, "roles", true, false),
                ("RoleBinding", RBAC_GROUP, "rolebindings", true, false),
                ("ClusterRole", RBAC_GROUP, "clusterroles", false, false),
                (
                    "ClusterRoleBinding",
                    RBAC_GROUP,
                    "clusterrolebindings",
                    false,
                    false
                ),
                ("Namespace", "", "namespaces", false, false),
                (
                    "NetworkPolicy",
                    "networking.k8s.io",
                    "networkpolicies",
                    true,
                    false
                ),
                (
                    "CiliumNetworkPolicy",
                    CILIUM_GROUP,
                    "ciliumnetworkpolicies",
                    true,
                    false
                ),
                (
                    "CiliumClusterwideNetworkPolicy",
                    CILIUM_GROUP,
                    "ciliumclusterwidenetworkpolicies",
                    false,
                    false
                ),
                ("Application", ARGO_GROUP, "applications", true, false),
                ("ApplicationSet", ARGO_GROUP, "applicationsets", true, false),
                ("AppProject", ARGO_GROUP, "appprojects", true, false),
            ]
        );
        let versions: Vec<_> = Kind::ALL
            .into_iter()
            .filter(|k| k.version() != "v1")
            .map(|k| (k, k.version()))
            .collect();
        assert_eq!(
            versions,
            [
                (Kind::CiliumNetworkPolicy, "v2"),
                (Kind::CiliumClusterwideNetworkPolicy, "v2"),
                (Kind::Application, "v1alpha1"),
                (Kind::ApplicationSet, "v1alpha1"),
                (Kind::AppProject, "v1alpha1"),
            ]
        );
        let policies: Vec<_> = Kind::ALL.into_iter().filter(|k| k.is_policy()).collect();
        assert_eq!(
            policies,
            [
                Kind::NetworkPolicy,
                Kind::CiliumNetworkPolicy,
                Kind::CiliumClusterwideNetworkPolicy
            ]
        );
        assert_eq!(
            Kind::HttpRoute.resource(),
            ResourceRef {
                group: GATEWAY_GROUP.into(),
                version: "v1".into(),
                plural: "httproutes".into(),
                kind: "HTTPRoute".into(),
                namespaced: true,
            }
        );
        assert_eq!(
            Kind::CiliumClusterwideNetworkPolicy.resource(),
            ResourceRef {
                group: CILIUM_GROUP.into(),
                version: "v2".into(),
                plural: "ciliumclusterwidenetworkpolicies".into(),
                kind: "CiliumClusterwideNetworkPolicy".into(),
                namespaced: false,
            }
        );
        assert_eq!(
            Kind::Application.resource(),
            ResourceRef {
                group: ARGO_GROUP.into(),
                version: "v1alpha1".into(),
                plural: "applications".into(),
                kind: "Application".into(),
                namespaced: true,
            }
        );
        let gateway_api: Vec<_> = Kind::ALL
            .into_iter()
            .filter(|k| k.is_gateway_api())
            .collect();
        assert_eq!(
            gateway_api,
            [Kind::GatewayClass, Kind::Gateway, Kind::HttpRoute]
        );
        let access: Vec<_> = Kind::ALL.into_iter().filter(|k| k.is_access()).collect();
        assert_eq!(
            access,
            [
                Kind::Role,
                Kind::RoleBinding,
                Kind::ClusterRole,
                Kind::ClusterRoleBinding
            ]
        );
        assert_eq!(
            Kind::ClusterRoleBinding.resource(),
            ResourceRef {
                group: RBAC_GROUP.into(),
                version: "v1".into(),
                plural: "clusterrolebindings".into(),
                kind: "ClusterRoleBinding".into(),
                namespaced: false,
            }
        );
    }

    #[test]
    fn a_group_and_kind_name_their_kind() {
        for (group, kind, found) in [
            ("apps", "Deployment", Some(Kind::Deployment)),
            ("", "Service", Some(Kind::Service)),
            ("", "Namespace", Some(Kind::Namespace)),
            (
                "networking.k8s.io",
                "NetworkPolicy",
                Some(Kind::NetworkPolicy),
            ),
            (
                CILIUM_GROUP,
                "CiliumClusterwideNetworkPolicy",
                Some(Kind::CiliumClusterwideNetworkPolicy),
            ),
            (ARGO_GROUP, "Application", Some(Kind::Application)),
            (GATEWAY_GROUP, "HTTPRoute", Some(Kind::HttpRoute)),
            (RBAC_GROUP, "ClusterRole", Some(Kind::ClusterRole)),
            ("extensions", "Deployment", None),
            ("apps", "deployment", None),
            ("", "Deployment", None),
            ("apiextensions.k8s.io", "CustomResourceDefinition", None),
            ("example.com", "Widget", None),
        ] {
            assert_eq!(Kind::from_group_kind(group, kind), found, "{group}/{kind}");
        }
    }

    /// Discovery of a fake API server that also serves `resources`.
    async fn discovery_serving(resources: Vec<FakeResource>) -> Discovery {
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        for resource in resources {
            fake.serve_resource(resource);
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        fake.write_kubeconfig(&path, "fake").unwrap();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let options = KubeConfigOptions {
            context: Some("fake".into()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .unwrap();
        let client = Client::try_from(config).unwrap();
        Discovery::new(client).run().await.unwrap()
    }

    /// The fake serves Namespaces, Pods, Services, Deployments, ConfigMaps and Secrets itself.
    const FAKE_DEFAULTS: [Kind; 6] = [
        Kind::Pod,
        Kind::Service,
        Kind::Deployment,
        Kind::ConfigMap,
        Kind::Secret,
        Kind::Namespace,
    ];

    #[tokio::test]
    async fn served_kinds_checks_each_kind_at_its_own_version() {
        let served = served_kinds(
            &discovery_serving(vec![
                FakeResource::new(
                    "networking.k8s.io",
                    "v1",
                    "NetworkPolicy",
                    "networkpolicies",
                    true,
                ),
                FakeResource::new(
                    CILIUM_GROUP,
                    "v2",
                    "CiliumNetworkPolicy",
                    "ciliumnetworkpolicies",
                    true,
                ),
                FakeResource::new(
                    CILIUM_GROUP,
                    "v2",
                    "CiliumClusterwideNetworkPolicy",
                    "ciliumclusterwidenetworkpolicies",
                    false,
                ),
                FakeResource::new(ARGO_GROUP, "v1alpha1", "Application", "applications", true),
                FakeResource::new(
                    ARGO_GROUP,
                    "v1alpha1",
                    "ApplicationSet",
                    "applicationsets",
                    true,
                ),
                FakeResource::new(ARGO_GROUP, "v1alpha1", "AppProject", "appprojects", true),
            ])
            .await,
        );
        let mut expected = FAKE_DEFAULTS.to_vec();
        expected.extend([
            Kind::NetworkPolicy,
            Kind::CiliumNetworkPolicy,
            Kind::CiliumClusterwideNetworkPolicy,
            Kind::Application,
            Kind::ApplicationSet,
            Kind::AppProject,
        ]);
        assert_eq!(served, expected);

        let elsewhere = served_kinds(
            &discovery_serving(vec![
                FakeResource::new(
                    CILIUM_GROUP,
                    "v2alpha1",
                    "CiliumNetworkPolicy",
                    "ciliumnetworkpolicies",
                    true,
                ),
                FakeResource::new(
                    CILIUM_GROUP,
                    "v2alpha1",
                    "CiliumClusterwideNetworkPolicy",
                    "ciliumclusterwidenetworkpolicies",
                    false,
                ),
                FakeResource::new(ARGO_GROUP, "v1beta1", "Application", "applications", true),
            ])
            .await,
        );
        assert_eq!(elsewhere, FAKE_DEFAULTS, "another version is not served");
    }
}
