//! Tunnel passwords (tunnels spec §5.3): the keychain's `SkoposIDE tunnels` service, one account
//! per tunnel and slot, and memory for this run when the keychain refuses.

use std::sync::Arc;

use dashmap::DashMap;

use super::model::TunnelDef;
use super::store::{gone, TunnelView};
use crate::app_core::{AppCore, CoreEvent};
use crate::blocking::blocking;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::secrets::{Secret, SecretStore};

/// What `Password` shows when the keychain refused the password (spec §5.3).
pub(crate) fn kept_in_memory(reason: &str) -> String {
    format!("Kept until SkoposIDE quits: the system keychain is not available ({reason})")
}

/// The reason inside a `keychain_unavailable` message, or the whole message.
fn keychain_reason(message: &str) -> String {
    message
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map_or_else(|| message.to_owned(), |(reason, _)| reason.to_owned())
}

/// The keychain account of a proxy tunnel's password.
pub(crate) fn proxy_password_account(tunnel: &str) -> String {
    format!("{tunnel}:proxy-password")
}

/// The store, and the secrets read from it or set during this run.
pub(crate) struct TunnelSecrets {
    store: Arc<dyn SecretStore>,
    /// Each secret, and why the store refused it when it lives in memory only.
    kept: DashMap<String, (Secret, Option<String>)>,
}

impl TunnelSecrets {
    pub(crate) fn new(store: Arc<dyn SecretStore>) -> Self {
        Self {
            store,
            kept: DashMap::new(),
        }
    }

    /// From memory once read. Reading the store can block.
    pub(crate) fn get(&self, account: &str) -> CoreResult<Option<Secret>> {
        if let Some(kept) = self.kept.get(account) {
            return Ok(Some(kept.0.clone()));
        }
        let secret = self.store.get(&account.to_owned())?;
        if let Some(secret) = &secret {
            self.kept.insert(account.to_owned(), (secret.clone(), None));
        }
        Ok(secret)
    }

    /// Saves the secret. `Err` is the keychain's reason when it refused; the secret is then
    /// kept in memory for this run. Blocks.
    pub(crate) fn set(&self, account: &str, secret: Secret) -> Result<(), String> {
        let refused = self
            .store
            .set(&account.to_owned(), &secret)
            .err()
            .map(|e| keychain_reason(&e.message));
        if let Some(reason) = &refused {
            tracing::warn!("a tunnel password is kept in memory only: {reason}");
        }
        self.kept
            .insert(account.to_owned(), (secret, refused.clone()));
        refused.map_or(Ok(()), Err)
    }

    /// Forgets the secrets held in memory whose account starts with `prefix`: the answers a
    /// deleted tunnel kept without the keychain. The keychain ones are in `remembered`.
    pub(crate) fn forget_memory(&self, prefix: &str) {
        self.kept.retain(|account, _| !account.starts_with(prefix));
    }

    /// Forgets the secret. A store that cannot delete it only logs. Blocks.
    pub(crate) fn delete(&self, account: &str) {
        self.kept.remove(account);
        if let Err(e) = self.store.delete(&account.to_owned()) {
            tracing::warn!("a tunnel password could not be deleted: {}", e.message);
        }
    }

    /// Why this run holds the secret in memory only, if it does.
    pub(crate) fn memory_only(&self, account: &str) -> Option<String> {
        self.kept.get(account).and_then(|kept| kept.1.clone())
    }
}

impl AppCore {
    /// Saves a proxy tunnel's password (spec §5.3). Blocks on the keychain.
    pub fn tunnel_set_password(&self, id: &str, password: Secret) -> CoreResult<TunnelView> {
        let def = self.tunnel_def(id).ok_or_else(gone)?;
        if password.expose().is_empty() {
            return Err(IpcError::new(
                ErrorCode::InvalidInput,
                "Enter a password, or clear the saved one.",
            ));
        }
        let account = proxy_password_account(&def.id);
        let stored = self.tunnel_secrets().set(&account, password).is_ok();
        self.tunnels_store().update(|all| {
            if let Some(tunnel) = all.iter_mut().find(|t| t.id == def.id) {
                tunnel.remembered.retain(|kept| kept != &account);
                if stored {
                    tunnel.remembered.push(account.clone());
                }
            }
        })?;
        self.tunnel_runtime().reset(&def.id);
        self.emit(CoreEvent::TunnelsChanged);
        self.tunnel_def(id)
            .map(|d| self.tunnel_view(&d))
            .ok_or_else(gone)
    }

    /// Forgets a proxy tunnel's password. Blocks on the keychain.
    pub fn tunnel_clear_password(&self, id: &str) -> CoreResult<TunnelView> {
        let def = self.tunnel_def(id).ok_or_else(gone)?;
        let account = proxy_password_account(&def.id);
        self.tunnel_secrets().delete(&account);
        self.tunnels_store().update(|all| {
            if let Some(tunnel) = all.iter_mut().find(|t| t.id == def.id) {
                tunnel.remembered.retain(|kept| kept != &account);
            }
        })?;
        self.tunnel_runtime().reset(&def.id);
        self.emit(CoreEvent::TunnelsChanged);
        self.tunnel_def(id)
            .map(|d| self.tunnel_view(&d))
            .ok_or_else(gone)
    }

    /// A tunnel's proxy password, read off the Tokio workers.
    pub(crate) async fn tunnel_password(&self, id: &str) -> CoreResult<Option<Secret>> {
        let core = self.clone();
        let account = proxy_password_account(id);
        blocking(move || core.tunnel_secrets().get(&account)).await
    }

    /// Deletes every secret a tunnel wrote, and the one held in memory. Blocks.
    pub(crate) fn tunnel_forget_secrets(&self, def: &TunnelDef) {
        for account in &def.remembered {
            self.tunnel_secrets().delete(account);
        }
        self.tunnel_secrets()
            .delete(&proxy_password_account(&def.id));
        self.tunnel_secrets().forget_memory(&format!("{}:", def.id));
    }

    /// Whether the tunnel has a password, and the note when it lives in memory only.
    pub(crate) fn tunnel_password_state(&self, def: &TunnelDef) -> (bool, Option<String>) {
        let account = proxy_password_account(&def.id);
        let memory_only = self.tunnel_secrets().memory_only(&account);
        let has = memory_only.is_some() || def.remembered.contains(&account);
        (has, memory_only.map(|reason| kept_in_memory(&reason)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::keychain_unavailable;

    #[test]
    fn the_reason_comes_out_of_the_keychain_message() {
        let message = keychain_unavailable("no Secret Service").message;
        assert_eq!(keychain_reason(&message), "no Secret Service");
        assert_eq!(keychain_reason("locked"), "locked");
    }
}
