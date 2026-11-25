//! The agent and chat commands (agents spec §5.2). Each is a thin call into `AppCore`,
//! which answers `Unsupported` on Windows. A chat belongs to the window that starts it,
//! so the window's reload or close ends it with its other sessions (`sessions_stop_owned`).

use skopos_core::agents::approvals::ChangeAnswer;
use skopos_core::agents::chat::{ChatInfo, ChatScope, ChatStart};
use skopos_core::agents::chats::{ChatSummary, StoredChat};
use skopos_core::agents::editor_tab::EditorTab;
use skopos_core::agents::events::{ChatEvent, ObjectRef};
use skopos_core::agents::registry::AgentStatus;
use skopos_core::blocking::blocking;
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::{AgentChanges, AgentPrefs, ClusterAgentSettings};
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use crate::state::AppState;

/// Chat events wait here while the webview catches up.
const CHAT_BACKLOG: usize = 64;

#[tauri::command]
pub async fn agents_status(state: State<'_, AppState>) -> Result<Vec<AgentStatus>, IpcError> {
    let core = state.core.clone();
    blocking(move || core.agents_status()).await
}

#[tauri::command]
pub async fn agent_probe(state: State<'_, AppState>, id: String) -> Result<AgentStatus, IpcError> {
    state.core.agent_probe(&id).await
}

#[tauri::command]
pub async fn agent_custom_add(
    state: State<'_, AppState>,
    name: String,
    command: String,
) -> Result<AgentStatus, IpcError> {
    let core = state.core.clone();
    blocking(move || core.agent_custom_add(&name, &command)).await
}

#[tauri::command]
pub async fn agent_custom_remove(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.agent_custom_remove(&id)).await
}

#[tauri::command]
pub async fn agent_default_set(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.agent_default_set(&id)).await
}

#[tauri::command]
pub async fn agent_prefs(state: State<'_, AppState>) -> Result<AgentPrefs, IpcError> {
    Ok(state.core.agent_prefs())
}

#[tauri::command]
pub async fn cluster_agent_changes_set(
    state: State<'_, AppState>,
    id: ClusterId,
    changes: AgentChanges,
) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.cluster_agent_changes_set(&id, changes)).await
}

#[tauri::command]
pub async fn cluster_agent_settings(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ClusterAgentSettings, IpcError> {
    Ok(state.core.cluster_agent_settings(&id))
}

/// Starts a chat owned by this window. Its events go to `on_event` until the chat ends.
#[tauri::command]
pub async fn chat_start(
    state: State<'_, AppState>,
    window: WebviewWindow,
    scope: ChatScope,
    agent: Option<String>,
    continue_chat: Option<String>,
    on_event: Channel<ChatEvent>,
) -> Result<ChatInfo, IpcError> {
    let (tx, mut rx) = mpsc::channel(CHAT_BACKLOG);
    let start = ChatStart {
        scope,
        agent,
        continue_chat,
    };
    let info = state.core.chat_start(start, tx, window.label()).await?;
    let core = state.core.clone();
    let chat = info.chat_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                core.chat_close(&chat).await;
                break;
            }
        }
    });
    Ok(info)
}

/// Runs one turn; resolves when it ends. Its items arrive on the chat's channel meanwhile.
#[tauri::command]
pub async fn chat_prompt(
    state: State<'_, AppState>,
    chat_id: String,
    text: String,
    object: Option<ObjectRef>,
    tab: Option<EditorTab>,
) -> Result<(), IpcError> {
    state.core.chat_prompt(&chat_id, text, object, tab).await
}

#[tauri::command]
pub async fn chat_stop(state: State<'_, AppState>, chat_id: String) -> Result<(), IpcError> {
    state.core.chat_stop(&chat_id);
    Ok(())
}

#[tauri::command]
pub async fn chat_close(state: State<'_, AppState>, chat_id: String) -> Result<(), IpcError> {
    state.core.chat_close(&chat_id).await;
    Ok(())
}

#[tauri::command]
pub async fn chat_answer(
    state: State<'_, AppState>,
    chat_id: String,
    card_id: String,
    answer: ChangeAnswer,
) -> Result<(), IpcError> {
    state.core.chat_answer(&chat_id, &card_id, answer)
}

#[tauri::command]
pub async fn chat_permission(
    state: State<'_, AppState>,
    chat_id: String,
    card_id: String,
    option_id: String,
) -> Result<(), IpcError> {
    state.core.chat_permission(&chat_id, &card_id, &option_id)
}

#[tauri::command]
pub async fn chat_proposal_answer(
    state: State<'_, AppState>,
    chat_id: String,
    proposal_id: String,
    accepted: bool,
) -> Result<(), IpcError> {
    state
        .core
        .chat_proposal_answer(&chat_id, &proposal_id, accepted)
        .await
}

#[tauri::command]
pub async fn chat_detach_tab(
    state: State<'_, AppState>,
    chat_id: String,
    tab_id: String,
) -> Result<(), IpcError> {
    state.core.chat_detach_tab(&chat_id, &tab_id).await;
    Ok(())
}

#[tauri::command]
pub async fn chat_undo_standing(
    state: State<'_, AppState>,
    chat_id: String,
    cluster_id: ClusterId,
) -> Result<(), IpcError> {
    state.core.chat_undo_standing(&chat_id, &cluster_id)
}

#[tauri::command]
pub async fn chat_list(
    state: State<'_, AppState>,
    scope: ChatScope,
) -> Result<Vec<ChatSummary>, IpcError> {
    let core = state.core.clone();
    blocking(move || core.chat_list(&scope)).await
}

#[tauri::command]
pub async fn chat_get(state: State<'_, AppState>, id: String) -> Result<StoredChat, IpcError> {
    let core = state.core.clone();
    blocking(move || core.chat_get(&id)).await
}
