//! The tunnels store and the commands that edit it (tunnels spec §5.2).

use serde::Serialize;
use ts_rs::TS;

use super::model::{invalid, tunnel_name, TunnelDef, TunnelInput, TunnelKind};
use super::prompts::TunnelPrompt;
use super::state::TunnelState;
use crate::agents::endpoint::new_token;
use crate::app_core::{AppCore, CoreEvent};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

pub(crate) const TUNNELS_FILE: &str = "tunnels.json";
const GONE: &str = "This tunnel no longer exists.";

pub(crate) fn gone() -> IpcError {
    IpcError::new(ErrorCode::NotFound, GONE)
}

/// One tunnel as the webview sees it: never a secret (spec T1).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelView {
    pub id: String,
    pub name: String,
    pub kind: TunnelKind,
    /// How many clusters pick this tunnel in their settings.
    pub cluster_count: u32,
    pub has_password: bool,
    /// Set when the password lives in memory only (spec §5.3).
    pub password_note: Option<String>,
    pub state: TunnelState,
    /// The oldest SSH prompt that waits for the person (spec §6.3).
    pub prompt: Option<TunnelPrompt>,
    /// The last lines `ssh` wrote to stderr; empty for a proxy tunnel (spec §6.1).
    pub log: Vec<String>,
}

impl AppCore {
    /// The tunnels, by name.
    pub fn tunnel_list(&self) -> Vec<TunnelView> {
        let mut views: Vec<TunnelView> = self
            .tunnels_store()
            .get()
            .iter()
            .map(|def| self.tunnel_view(def))
            .collect();
        views.sort_by_key(|view| view.name.to_lowercase());
        views
    }

    /// Adds a tunnel (`input.id` is `None`) or changes one. Names are unique, ignoring case.
    pub fn tunnel_save(&self, input: TunnelInput) -> CoreResult<TunnelView> {
        let name = tunnel_name(&input.name)?;
        let kind = input.kind.normalized()?;
        let (saved, changed) = self.tunnels_store().try_update(|all| {
            let lower = name.to_lowercase();
            let taken = all
                .iter()
                .any(|t| Some(&t.id) != input.id.as_ref() && t.name.to_lowercase() == lower);
            if taken {
                return Err(invalid(format!(
                    "A tunnel named \"{name}\" exists already."
                )));
            }
            match &input.id {
                Some(id) => {
                    let def = all.iter_mut().find(|t| &t.id == id).ok_or_else(gone)?;
                    let changed = def.kind != kind;
                    def.name = name.clone();
                    def.kind = kind.clone();
                    Ok((def.clone(), changed))
                }
                None => {
                    let def = TunnelDef {
                        id: new_token(),
                        name: name.clone(),
                        kind: kind.clone(),
                        remembered: Vec::new(),
                    };
                    all.push(def.clone());
                    Ok((def, false))
                }
            }
        })?;
        if changed {
            self.tunnel_runtime().reset(&saved.id);
        }
        self.emit(CoreEvent::TunnelsChanged);
        Ok(self.tunnel_view(&saved))
    }

    /// Deletes a tunnel; the clusters that picked it go back to none.
    pub fn tunnel_delete(&self, id: &str) -> CoreResult<()> {
        let removed = self.tunnels_store().try_update(|all| {
            let at = all.iter().position(|t| t.id == id).ok_or_else(gone)?;
            Ok(all.remove(at))
        })?;
        self.tunnel_forget_secrets(&removed);
        self.tunnel_runtime().forget(id);
        self.cluster_settings_store().update(|all| {
            for settings in all.values_mut() {
                if settings.tunnel.as_deref() == Some(id) {
                    settings.tunnel = None;
                }
            }
        })?;
        self.emit(CoreEvent::TunnelsChanged);
        self.emit(CoreEvent::CatalogChanged);
        Ok(())
    }

    /// The tunnel with this id, if it still exists.
    pub(crate) fn tunnel_def(&self, id: &str) -> Option<TunnelDef> {
        self.tunnels_store().get().into_iter().find(|t| t.id == id)
    }

    /// The tunnel a cluster picked, when it still exists (spec §5.2).
    pub(crate) fn cluster_tunnel(&self, cluster: &ClusterId) -> Option<TunnelDef> {
        self.cluster_settings_get(cluster)
            .tunnel
            .and_then(|id| self.tunnel_def(&id))
    }

    pub(crate) fn tunnel_view(&self, def: &TunnelDef) -> TunnelView {
        let count = self
            .cluster_settings_store()
            .get()
            .values()
            .filter(|s| s.tunnel.as_deref() == Some(def.id.as_str()))
            .count();
        let (has_password, password_note) = self.tunnel_password_state(def);
        TunnelView {
            id: def.id.clone(),
            name: def.name.clone(),
            kind: def.kind.clone(),
            cluster_count: u32::try_from(count).unwrap_or(u32::MAX),
            has_password,
            password_note,
            state: self.tunnel_state(&def.id),
            prompt: self.tunnel_runtime().prompts.first(&def.id),
            log: self.tunnel_runtime().ssh.log_lines(&def.id),
        }
    }
}
