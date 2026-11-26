//! What a connect needs of a cluster's tunnel (tunnels spec §5.7).

use super::model::TunnelDef;
use super::runtime::host_port;
use crate::app_core::AppCore;
use crate::error::CoreResult;
use crate::kubeconfig::ClusterId;
use crate::secrets::Secret;

pub(crate) struct TunnelRoute {
    core: AppCore,
    def: TunnelDef,
    /// `U(T)`, which holds this run's token.
    pub(crate) url: Secret,
}

impl std::fmt::Debug for TunnelRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelRoute")
            .field("name", &self.def.name)
            .finish_non_exhaustive()
    }
}

impl TunnelRoute {
    pub(crate) fn name(&self) -> &str {
        &self.def.name
    }

    pub(crate) fn trust_marker(&self) -> String {
        self.def.kind.trust_marker()
    }

    /// Dials the API server through the tunnel once and closes the connection, so a refusal
    /// reaches the person with the upstream's own reason. `Err` is that reason.
    pub(crate) async fn probe(&self, server: Option<&str>) -> Result<(), String> {
        let Some((host, port)) = server.and_then(host_port) else {
            // No server: `kube` says so with its own message.
            return Ok(());
        };
        self.core
            .tunnel_dial(&self.def, &host, port)
            .await
            .map(drop)
            .map_err(|e| e.reason())
    }
}

impl AppCore {
    /// The route of a cluster whose `tunnel` names a tunnel that exists.
    pub(crate) fn cluster_route(&self, id: &ClusterId) -> CoreResult<Option<TunnelRoute>> {
        let Some(def) = self.cluster_tunnel(id) else {
            return Ok(None);
        };
        let url = self.tunnel_url(&def)?;
        Ok(Some(TunnelRoute {
            core: self.clone(),
            def,
            url,
        }))
    }
}
