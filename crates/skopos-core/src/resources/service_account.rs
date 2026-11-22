//! A kubeconfig for one ServiceAccount, written straight to a file. The token comes from the
//! TokenRequest API and never crosses IPC (section 5.5 of the milestone spec): only its
//! expiry is returned.

use std::path::Path;

use k8s_openapi::api::authentication::v1::{TokenRequest, TokenRequestSpec};
use k8s_openapi::api::core::v1::ServiceAccount;
use kube::api::PostParams;
use kube::Api;
use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

use super::kubeconfig_export::{check_destination, source_cluster, write_kubeconfig};
use super::ops::{invalid, is_path_segment};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

const DEFAULT_LIFETIME_SECONDS: i64 = 3600;
/// What saving returns. The token stays out of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SavedKubeconfig {
    pub expires_at: String,
}

fn kubeconfig_document(cluster: Value, namespace: &str, name: &str, token: &str) -> Value {
    let label = format!("{name}@{namespace}");
    json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{ "name": label, "cluster": cluster }],
        "users": [{ "name": label, "user": { "token": token } }],
        "contexts": [{
            "name": label,
            "context": { "cluster": label, "user": label, "namespace": namespace },
        }],
        "current-context": label,
    })
}

fn no_token() -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        "the API server returned no usable token",
    )
}

impl AppCore {
    /// Requests a token for the ServiceAccount, writes a kubeconfig using it to `dest` with
    /// mode 0600 on Unix, and returns when the token expires. The destination is checked
    /// first, so a bad path spends no token.
    pub async fn service_account_kubeconfig_save(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        dest: &Path,
        expiration_seconds: Option<i64>,
    ) -> CoreResult<SavedKubeconfig> {
        if !is_path_segment(namespace) || !is_path_segment(name) {
            return Err(invalid("the namespace or name is not valid"));
        }
        check_destination(dest)?;
        let client = self.cluster_client(id)?;
        let cluster = source_cluster(&self.cluster_kubeconfig_path(id)?)?.cluster;

        let accounts: Api<ServiceAccount> = Api::namespaced(client, namespace);
        let request = TokenRequest {
            spec: Some(TokenRequestSpec {
                expiration_seconds: Some(expiration_seconds.unwrap_or(DEFAULT_LIFETIME_SECONDS)),
                ..TokenRequestSpec::default()
            }),
            ..TokenRequest::default()
        };
        let answer = accounts
            .create_token_request(name, &PostParams::default(), &request)
            .await?;
        let status = answer.status.ok_or_else(no_token)?;
        let token = status
            .token
            .filter(|token| !token.is_empty())
            .ok_or_else(no_token)?;
        let expires_at = status.expiration_timestamp.ok_or_else(no_token)?;
        let document = kubeconfig_document(cluster, namespace, name, &token);
        let text = serde_yaml_ng::to_string(&document)
            .map_err(|_| IpcError::new(ErrorCode::Internal, "the kubeconfig cannot be written"))?;
        write_kubeconfig(dest, &text)?;
        Ok(SavedKubeconfig {
            expires_at: expires_at.0.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_document_is_a_complete_kubeconfig() {
        let document = kubeconfig_document(json!({ "server": "s" }), "ns", "sa", "tok");
        assert_eq!(document["current-context"], "sa@ns");
        assert_eq!(document["users"][0]["user"]["token"], "tok");
        assert_eq!(document["contexts"][0]["context"]["namespace"], "ns");
        assert_eq!(document["clusters"][0]["cluster"]["server"], "s");
    }
}
