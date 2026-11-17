//! The kinds the graph reads (spec E §4.2, O §4.1), and where each one is listed.

use kube::Discovery;

use crate::resources::ResourceRef;

pub(crate) const GATEWAY_GROUP: &str = "gateway.networking.k8s.io";
pub(crate) const RBAC_GROUP: &str = "rbac.authorization.k8s.io";

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
}

impl Kind {
    pub(crate) const ALL: [Kind; 20] = [
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
        }
    }

    pub(crate) fn group(self) -> &'static str {
        match self {
            Kind::Deployment | Kind::ReplicaSet | Kind::StatefulSet | Kind::DaemonSet => "apps",
            Kind::Job | Kind::CronJob => "batch",
            Kind::Ingress => "networking.k8s.io",
            Kind::GatewayClass | Kind::Gateway | Kind::HttpRoute => GATEWAY_GROUP,
            Kind::Role | Kind::RoleBinding | Kind::ClusterRole | Kind::ClusterRoleBinding => {
                RBAC_GROUP
            }
            _ => "",
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
        }
    }

    pub(crate) fn namespaced(self) -> bool {
        !matches!(
            self,
            Kind::GatewayClass | Kind::ClusterRole | Kind::ClusterRoleBinding
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

    /// The resource the watch hub lists, always at `v1`.
    pub(crate) fn resource(self) -> ResourceRef {
        ResourceRef {
            group: self.group().to_owned(),
            version: "v1".to_owned(),
            plural: self.plural().to_owned(),
            kind: self.name().to_owned(),
            namespaced: self.namespaced(),
        }
    }
}

/// The kinds the cluster serves at `v1`, in `Kind::ALL` order. A kind it does not serve is not
/// read and is not reported missing (spec E §4.2).
pub(crate) fn served_kinds(discovery: &Discovery) -> Vec<Kind> {
    Kind::ALL
        .into_iter()
        .filter(|kind| {
            discovery.get(kind.group()).is_some_and(|group| {
                group
                    .versioned_resources("v1")
                    .iter()
                    .any(|(resource, _)| resource.plural == kind.plural())
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
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
}
