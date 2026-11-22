//! Users and groups from client certificates (spec 2026-11-22 §5.2). Each command delegates
//! to `AppCore`.

use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::{
    certificate_request_describe as describe, BindingRef, CertUserEvent, CertUserRequest,
    CertificateRequestInfo, CsrDecision, SubjectRef, SubjectRemoval,
};
use skopos_core::save_file;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use super::save::ask_save_path;
use crate::state::AppState;

/// Events wait here while the webview catches up.
const CERT_USER_BACKLOG: usize = 32;

/// Asks where to save first: `None` when the person cancels, and then nothing is created.
#[tauri::command]
pub async fn cert_user_create_start(
    state: State<'_, AppState>,
    window: WebviewWindow,
    cluster_id: ClusterId,
    request: CertUserRequest,
    suggested_name: String,
    on_event: Channel<CertUserEvent>,
) -> Result<Option<String>, IpcError> {
    let Some(dest) = ask_save_path(&window, save_file::KUBECONFIG, &suggested_name).await? else {
        return Ok(None);
    };
    let (tx, mut rx) = mpsc::channel(CERT_USER_BACKLOG);
    let id = state
        .core
        .cert_user_create_start(&cluster_id, request, &dest, tx, window.label())
        .await?;
    let core = state.core.clone();
    let run = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                core.cert_user_create_cancel(&run);
                break;
            }
        }
    });
    Ok(Some(id))
}

#[tauri::command]
pub async fn cert_user_create_cancel(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), IpcError> {
    state.core.cert_user_create_cancel(&run_id);
    Ok(())
}

#[tauri::command]
pub async fn access_subject_remove(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    subject: SubjectRef,
    bindings: Vec<BindingRef>,
) -> Result<Vec<SubjectRemoval>, IpcError> {
    state
        .core
        .access_subject_remove(&cluster_id, &subject, &bindings)
        .await
}

#[tauri::command]
pub async fn csr_set_approval(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
    decision: CsrDecision,
) -> Result<(), IpcError> {
    state
        .core
        .csr_set_approval(&cluster_id, &name, decision)
        .await
}

#[tauri::command]
pub async fn certificate_request_describe(
    request: String,
    certificate: Option<String>,
) -> Result<CertificateRequestInfo, IpcError> {
    describe(&request, certificate.as_deref())
}
