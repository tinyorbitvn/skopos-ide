//! The create run (spec 2026-11-22 §5.1): key, request, approval, certificate, kubeconfig,
//! binding. Events go to an mpsc sender; the run stops on cancel, on disconnect and when
//! nobody listens. Tracing names the request and the step, never PEM.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::certificates::v1::{
    CertificateSigningRequest, CertificateSigningRequestCondition, CertificateSigningRequestSpec,
};
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding, RoleRef, Subject};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use k8s_openapi::jiff::Timestamp;
use k8s_openapi::ByteString;
use kube::api::{DeleteParams, PostParams};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use kube::{Api, Client};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::csr::generate;
use super::request::{binding_name, csr_prefix, CertUserRequest, RoleGrant};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::csr::{certificate_expiry, set_approval, CsrDecision};
use crate::resources::kubeconfig_export::{
    check_destination, client_cert_kubeconfig, source_cluster, write_kubeconfig, SourceCluster,
};
use crate::resources::subjects::BindingKind;

const SIGNER: &str = "kubernetes.io/kube-apiserver-client";
const RBAC_GROUP: &str = "rbac.authorization.k8s.io";
/// How long deleting an unused request may take before the run gives up on it.
const CLEANUP_LIMIT: Duration = Duration::from_secs(10);
const NO_APPROVAL: &str = "No one approved the request within 15 minutes. It was deleted.";
const NO_CERTIFICATE: &str = "The cluster approved the request, but no certificate came within 60 seconds. Managed clusters, such as EKS, may not sign kube-apiserver-client requests.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum CertUserStep {
    GenerateKey,
    Submit,
    Approve,
    WaitForCertificate,
    Save,
    Bind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BoundBinding {
    pub kind: BindingKind,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CertUserEvent {
    Started {
        step: CertUserStep,
    },
    Submitted {
        csr_name: String,
    },
    /// The person may not approve. Someone else must, before `deadline` (RFC 3339).
    WaitingForApproval {
        csr_name: String,
        deadline: String,
    },
    Approved,
    Issued {
        expires_at: String,
    },
    Saved,
    Bound {
        binding: BoundBinding,
    },
    /// The kubeconfig is saved; only the binding failed.
    BindingFailed {
        binding: BoundBinding,
        error: IpcError,
    },
    Done {
        expires_at: String,
        binding: Option<BoundBinding>,
    },
    Failed {
        step: CertUserStep,
        error: IpcError,
    },
    Cancelled,
}

/// How long the run waits. Tests make them short.
#[derive(Debug, Clone, Copy)]
pub struct CertUserLimits {
    /// For someone to approve, from when the request is sent.
    pub approval: Duration,
    /// For the certificate, from when the request is approved.
    pub issue: Duration,
}

impl Default for CertUserLimits {
    fn default() -> Self {
        Self {
            approval: Duration::from_secs(15 * 60),
            issue: Duration::from_secs(60),
        }
    }
}

/// A create run in progress.
pub(crate) struct RunningCertUser {
    token: CancellationToken,
    /// The label of the window that started the run.
    owner: String,
}

struct RunInput {
    client: Client,
    source: SourceCluster,
    request: CertUserRequest,
    dest: PathBuf,
    limits: CertUserLimits,
}

/// What the run has done, for the cleanup after it stops.
#[derive(Default)]
struct Progress {
    csr: Option<String>,
    saved: bool,
}

type StepResult<T> = Result<T, (CertUserStep, IpcError)>;

fn at(step: CertUserStep) -> impl FnOnce(IpcError) -> (CertUserStep, IpcError) {
    move |error| (step, error)
}

async fn send(tx: &mpsc::Sender<CertUserEvent>, event: CertUserEvent) {
    // A closed channel stops the run through `tx.closed()`.
    let _ = tx.send(event).await;
}

async fn started(tx: &mpsc::Sender<CertUserEvent>, step: CertUserStep) {
    send(tx, CertUserEvent::Started { step }).await;
}

/// `after` from now, in whole seconds, as RFC 3339.
fn deadline_text(after: Duration) -> String {
    let seconds = i64::try_from(after.as_secs()).unwrap_or(i64::MAX / 2);
    Timestamp::from_second(Timestamp::now().as_second().saturating_add(seconds))
        .map_or_else(|_| Timestamp::MAX.to_string(), |t| t.to_string())
}

/// The reason a condition gives, as a clause: no ending period.
fn why(condition: &CertificateSigningRequestCondition) -> String {
    let text = condition
        .message
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .or(condition.reason.as_deref().filter(|r| !r.trim().is_empty()))
        .unwrap_or("no reason given");
    text.trim().trim_end_matches('.').to_owned()
}

fn condition<'a>(
    conditions: &'a [CertificateSigningRequestCondition],
    kind: &str,
) -> Option<&'a CertificateSigningRequestCondition> {
    conditions
        .iter()
        .find(|c| c.type_ == kind && c.status == "True")
}

fn waiting_step(approved: bool) -> CertUserStep {
    if approved {
        CertUserStep::WaitForCertificate
    } else {
        CertUserStep::Approve
    }
}

fn deleted(name: &str, approved: bool) -> (CertUserStep, IpcError) {
    (
        waiting_step(approved),
        IpcError::new(
            ErrorCode::NotFound,
            format!("the signing request {name} was deleted before a certificate was issued"),
        ),
    )
}

/// A watch the API server refuses with 403 does not get better by waiting.
fn refused(error: watcher::Error) -> Option<IpcError> {
    let source = match error {
        watcher::Error::InitialListFailed(source)
        | watcher::Error::WatchStartFailed(source)
        | watcher::Error::WatchFailed(source) => source,
        watcher::Error::WatchError(status) => kube::Error::Api(status),
        watcher::Error::NoResourceVersion => return None,
    };
    let error = IpcError::from(source);
    (error.code == ErrorCode::Forbidden).then_some(error)
}

fn signing_request(request: &CertUserRequest, pem: &str) -> CertificateSigningRequest {
    CertificateSigningRequest {
        metadata: ObjectMeta {
            generate_name: Some(csr_prefix(&request.user_name)),
            ..ObjectMeta::default()
        },
        spec: CertificateSigningRequestSpec {
            request: ByteString(pem.as_bytes().to_vec()),
            signer_name: SIGNER.to_owned(),
            usages: Some(vec!["client auth".to_owned()]),
            expiration_seconds: Some(i32::try_from(request.lifetime_seconds).unwrap_or(i32::MAX)),
            ..CertificateSigningRequestSpec::default()
        },
        status: None,
    }
}

/// Watches the one request until it has a certificate. Until an Approved condition is
/// seen, the approval deadline holds; from then, `issue` from that moment. A request of that
/// name with another uid is not this run's, as if the request were deleted.
async fn wait_for_certificate(
    api: &Api<CertificateSigningRequest>,
    name: &str,
    uid: &str,
    mut approved: bool,
    approval_deadline: Instant,
    issue: Duration,
    tx: &mpsc::Sender<CertUserEvent>,
) -> StepResult<Vec<u8>> {
    let mut deadline = if approved {
        Instant::now() + issue
    } else {
        approval_deadline
    };
    let config = watcher::Config::default().fields(&format!("metadata.name={name}"));
    let mut events = watcher::watcher(api.clone(), config)
        .default_backoff()
        .boxed();
    let mut listed = false;
    loop {
        let Ok(next) = tokio::time::timeout_at(deadline, events.next()).await else {
            let message = if approved {
                NO_CERTIFICATE
            } else {
                NO_APPROVAL
            };
            return Err((
                waiting_step(approved),
                IpcError::new(ErrorCode::Internal, message),
            ));
        };
        let csr = match next {
            Some(Ok(Event::Init)) => {
                listed = false;
                continue;
            }
            Some(Ok(Event::InitDone)) if !listed => return Err(deleted(name, approved)),
            Some(Ok(Event::InitDone)) => continue,
            Some(Ok(Event::InitApply(csr))) => {
                listed = true;
                csr
            }
            Some(Ok(Event::Apply(csr))) => csr,
            Some(Ok(Event::Delete(_))) | None => return Err(deleted(name, approved)),
            Some(Err(error)) => {
                tracing::debug!(csr = %name, %error, "the watch of the request failed");
                match refused(error) {
                    Some(error) => return Err((waiting_step(approved), error)),
                    // The backoff restarts the watch; the deadline still holds.
                    None => continue,
                }
            }
        };
        if csr.metadata.uid.as_deref() != Some(uid) {
            return Err(deleted(name, approved));
        }
        let status = csr.status.unwrap_or_default();
        let conditions = status.conditions.unwrap_or_default();
        if let Some(denied) = condition(&conditions, "Denied") {
            let message = format!("The request was denied: {}.", why(denied));
            return Err((
                CertUserStep::Approve,
                IpcError::new(ErrorCode::Forbidden, message),
            ));
        }
        if let Some(failed) = condition(&conditions, "Failed") {
            let message = format!(
                "the signer could not issue the certificate: {}",
                why(failed)
            );
            return Err((
                CertUserStep::WaitForCertificate,
                IpcError::new(ErrorCode::Internal, message),
            ));
        }
        if !approved && condition(&conditions, "Approved").is_some() {
            approved = true;
            deadline = Instant::now() + issue;
            tracing::info!(csr = %name, "someone approved the request");
            send(tx, CertUserEvent::Approved).await;
            started(tx, CertUserStep::WaitForCertificate).await;
        }
        if let Some(certificate) = status.certificate.filter(|c| !c.0.is_empty()) {
            return Ok(certificate.0);
        }
    }
}

fn bound_binding(user: &str, grant: &RoleGrant) -> BoundBinding {
    BoundBinding {
        kind: if grant.namespace.is_some() {
            BindingKind::RoleBinding
        } else {
            BindingKind::ClusterRoleBinding
        },
        namespace: grant.namespace.clone(),
        name: binding_name(user, &grant.role_name),
    }
}

/// Creates the grant's binding. An existing one is not overwritten: the API's 409 is
/// the answer.
async fn create_binding(
    client: &Client,
    user: &str,
    grant: &RoleGrant,
    binding: &BoundBinding,
) -> CoreResult<()> {
    let metadata = ObjectMeta {
        name: Some(binding.name.clone()),
        namespace: binding.namespace.clone(),
        ..ObjectMeta::default()
    };
    let role_ref = RoleRef {
        api_group: Some(RBAC_GROUP.to_owned()),
        kind: grant.role_kind.as_str().to_owned(),
        name: grant.role_name.clone(),
    };
    let subjects = Some(vec![Subject {
        api_group: Some(RBAC_GROUP.to_owned()),
        kind: "User".to_owned(),
        name: user.to_owned(),
        namespace: None,
    }]);
    let params = PostParams::default();
    match binding.namespace.as_deref() {
        Some(namespace) => {
            let made = RoleBinding {
                metadata,
                role_ref,
                subjects,
            };
            Api::<RoleBinding>::namespaced(client.clone(), namespace)
                .create(&params, &made)
                .await?;
        }
        None => {
            let made = ClusterRoleBinding {
                metadata,
                role_ref,
                subjects,
            };
            Api::<ClusterRoleBinding>::all(client.clone())
                .create(&params, &made)
                .await?;
        }
    }
    Ok(())
}

async fn steps(
    input: &RunInput,
    tx: &mpsc::Sender<CertUserEvent>,
    progress: &mut Progress,
) -> StepResult<CertUserEvent> {
    let request = &input.request;
    let api: Api<CertificateSigningRequest> = Api::all(input.client.clone());

    started(tx, CertUserStep::GenerateKey).await;
    let (key, request_pem) =
        generate(&request.user_name, &request.groups).map_err(at(CertUserStep::GenerateKey))?;

    started(tx, CertUserStep::Submit).await;
    let created = api
        .create(
            &PostParams::default(),
            &signing_request(request, &request_pem),
        )
        .await
        .map_err(|error| (CertUserStep::Submit, IpcError::from(error)))?;
    let csr_name = created.metadata.name.ok_or_else(|| {
        (
            CertUserStep::Submit,
            IpcError::new(
                ErrorCode::Internal,
                "the API server gave the request no name",
            ),
        )
    })?;
    let csr_uid = created.metadata.uid.ok_or_else(|| {
        (
            CertUserStep::Submit,
            IpcError::new(
                ErrorCode::Internal,
                "the API server gave the request no uid",
            ),
        )
    })?;
    progress.csr = Some(csr_name.clone());
    tracing::info!(csr = %csr_name, "sent a client certificate request");
    send(
        tx,
        CertUserEvent::Submitted {
            csr_name: csr_name.clone(),
        },
    )
    .await;
    let approval_deadline = Instant::now() + input.limits.approval;

    started(tx, CertUserStep::Approve).await;
    let approved = match set_approval(&api, &csr_name, &csr_uid, CsrDecision::Approve).await {
        Ok(()) => true,
        Err(error) if error.code == ErrorCode::Forbidden => {
            tracing::info!(csr = %csr_name, "waiting for someone to approve the request");
            let deadline = deadline_text(input.limits.approval);
            send(
                tx,
                CertUserEvent::WaitingForApproval {
                    csr_name: csr_name.clone(),
                    deadline,
                },
            )
            .await;
            false
        }
        // Someone decided first; the watch reads which way.
        Err(error) if error.code == ErrorCode::Conflict => false,
        Err(error) => return Err((CertUserStep::Approve, error)),
    };
    if approved {
        send(tx, CertUserEvent::Approved).await;
        started(tx, CertUserStep::WaitForCertificate).await;
    }
    let certificate = wait_for_certificate(
        &api,
        &csr_name,
        &csr_uid,
        approved,
        approval_deadline,
        input.limits.issue,
        tx,
    )
    .await?;
    let expires_at =
        certificate_expiry(&certificate).map_err(at(CertUserStep::WaitForCertificate))?;
    send(
        tx,
        CertUserEvent::Issued {
            expires_at: expires_at.clone(),
        },
    )
    .await;

    started(tx, CertUserStep::Save).await;
    let certificate_pem = String::from_utf8(certificate).map_err(|_| {
        (
            CertUserStep::WaitForCertificate,
            IpcError::new(
                ErrorCode::Internal,
                "the API server returned a certificate that cannot be read",
            ),
        )
    })?;
    let namespace = request
        .binding
        .as_ref()
        .and_then(|g| g.namespace.as_deref());
    let text = client_cert_kubeconfig(
        &input.source,
        &request.user_name,
        &certificate_pem,
        &key.pem(),
        namespace,
    )
    .map_err(at(CertUserStep::Save))?;
    write_kubeconfig(&input.dest, &text).map_err(at(CertUserStep::Save))?;
    drop(text);
    drop(key);
    progress.saved = true;
    tracing::info!(csr = %csr_name, "saved the kubeconfig");
    send(tx, CertUserEvent::Saved).await;

    let Some(grant) = &request.binding else {
        return Ok(CertUserEvent::Done {
            expires_at,
            binding: None,
        });
    };
    started(tx, CertUserStep::Bind).await;
    let binding = bound_binding(&request.user_name, grant);
    match create_binding(&input.client, &request.user_name, grant, &binding).await {
        Ok(()) => {
            send(
                tx,
                CertUserEvent::Bound {
                    binding: binding.clone(),
                },
            )
            .await;
            Ok(CertUserEvent::Done {
                expires_at,
                binding: Some(binding),
            })
        }
        Err(error) => {
            send(tx, CertUserEvent::BindingFailed { binding, error }).await;
            Ok(CertUserEvent::Done {
                expires_at,
                binding: None,
            })
        }
    }
}

/// Deletes a request the run no longer needs. Errors are only logged: the
/// controller-manager removes it within a day anyway.
async fn delete_request(client: &Client, name: &str) {
    let api: Api<CertificateSigningRequest> = Api::all(client.clone());
    match tokio::time::timeout(CLEANUP_LIMIT, api.delete(name, &DeleteParams::default())).await {
        Ok(Ok(_)) => tracing::info!(csr = %name, "deleted the unused request"),
        Ok(Err(error)) => {
            tracing::warn!(csr = %name, %error, "could not delete the unused request")
        }
        Err(_) => tracing::warn!(csr = %name, "deleting the unused request took too long"),
    }
}

impl AppCore {
    /// Starts creating a client-certificate user and returns the run's id. Events go to
    /// `tx`; the last is `Done`, `Failed` or `Cancelled`. The request and the destination
    /// are checked first, so a bad one costs nothing on the cluster.
    pub async fn cert_user_create_start(
        &self,
        id: &ClusterId,
        request: CertUserRequest,
        dest: &Path,
        tx: mpsc::Sender<CertUserEvent>,
        owner: &str,
    ) -> CoreResult<String> {
        self.cert_user_create_start_with(id, request, dest, tx, owner, CertUserLimits::default())
            .await
    }

    /// `cert_user_create_start` with other limits, for tests.
    #[doc(hidden)]
    pub async fn cert_user_create_start_with(
        &self,
        id: &ClusterId,
        request: CertUserRequest,
        dest: &Path,
        tx: mpsc::Sender<CertUserEvent>,
        owner: &str,
        limits: CertUserLimits,
    ) -> CoreResult<String> {
        let request = request.normalized()?;
        check_destination(dest)?;
        let source = source_cluster(&self.cluster_kubeconfig_path(id)?)?;
        let client = self.cluster_client(id)?;
        // This token is already a child of the connection's own.
        let token = self.cluster_cancel_token(id)?;
        let run_id = self.next_cert_user_id();
        self.cert_users().insert(
            run_id.clone(),
            RunningCertUser {
                token: token.clone(),
                owner: owner.to_owned(),
            },
        );
        let input = RunInput {
            client,
            source,
            request,
            dest: dest.to_owned(),
            limits,
        };
        let core = self.clone();
        let key = run_id.clone();
        tokio::spawn(async move {
            let mut progress = Progress::default();
            let event = tokio::select! {
                result = steps(&input, &tx, &mut progress) => {
                    result.unwrap_or_else(|(step, error)| CertUserEvent::Failed { step, error })
                }
                () = token.cancelled() => CertUserEvent::Cancelled,
                // Nobody is watching any more.
                () = tx.closed() => {
                    token.cancel();
                    CertUserEvent::Cancelled
                }
            };
            if !progress.saved {
                if let Some(name) = progress.csr.as_deref() {
                    delete_request(&input.client, name).await;
                }
            }
            core.cert_users().remove(&key);
            let _ = tx.send(event).await;
        });
        Ok(run_id)
    }

    /// Stops a create run. An id that is not running is ignored.
    pub fn cert_user_create_cancel(&self, run_id: &str) {
        if let Some(running) = self.cert_users().get(run_id) {
            running.token.cancel();
        }
    }

    /// Stops the create runs the window `owner` started, for when its page loads again or
    /// it closes: the page took their ids with it.
    pub fn cert_user_create_cancel_owned(&self, owner: &str) {
        for running in self.cert_users().iter().filter(|r| r.owner == owner) {
            running.token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn condition(
        message: Option<&str>,
        reason: Option<&str>,
    ) -> CertificateSigningRequestCondition {
        CertificateSigningRequestCondition {
            type_: "Denied".into(),
            status: "True".into(),
            message: message.map(str::to_owned),
            reason: reason.map(str::to_owned),
            ..CertificateSigningRequestCondition::default()
        }
    }

    #[test]
    fn a_reason_reads_as_a_clause() {
        assert_eq!(
            why(&condition(Some(" Not today. "), Some("Policy"))),
            "Not today"
        );
        assert_eq!(why(&condition(Some(""), Some("Policy"))), "Policy");
        assert_eq!(why(&condition(None, None)), "no reason given");
    }

    #[test]
    fn a_deadline_has_whole_seconds() {
        let text = deadline_text(Duration::from_secs(900));
        assert!(text.ends_with('Z') && !text.contains('.'), "{text}");
        let left = text
            .parse::<Timestamp>()
            .unwrap()
            .duration_since(Timestamp::now())
            .as_secs();
        assert!((898..=900).contains(&left), "{left}");
    }
}
