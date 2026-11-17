//! The OS keychain that keeps the password or token of each cluster's metrics URL (spec I47,
//! I48): macOS Keychain, Windows Credential Manager, or the Secret Service on Linux.

use keyring::Entry;
use skopos_core::error::{CoreResult, IpcError};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::secrets::{keychain_unavailable, Secret, SecretStore};

/// The keychain service of the metrics secrets; each entry's account is the cluster's id.
pub const SERVICE: &str = "SkoposIDE metrics";

/// One keychain service, an entry per cluster.
pub struct KeychainStore {
    service: &'static str,
}

impl KeychainStore {
    pub fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn entry(&self, cluster: &ClusterId) -> CoreResult<Entry> {
        Entry::new(self.service, cluster).map_err(unavailable)
    }
}

/// Any keychain failure but a missing entry means the keychain cannot be used (spec I51).
/// keyring's `Display` names the failure, never the secret: the bytes that `BadEncoding` and
/// `BadDataFormat` hold stay out of it.
fn unavailable(error: keyring::Error) -> IpcError {
    keychain_unavailable(&error.to_string())
}

impl SecretStore for KeychainStore {
    fn get(&self, cluster: &ClusterId) -> CoreResult<Option<Secret>> {
        match self.entry(cluster)?.get_password() {
            Ok(secret) => Ok(Some(Secret::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(unavailable(error)),
        }
    }

    fn set(&self, cluster: &ClusterId, secret: &Secret) -> CoreResult<()> {
        self.entry(cluster)?
            .set_password(secret.expose())
            .map_err(unavailable)
    }

    fn delete(&self, cluster: &ClusterId) -> CoreResult<()> {
        match self.entry(cluster)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(unavailable(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use skopos_core::error::ErrorCode;

    use super::*;

    #[test]
    fn a_keychain_failure_is_unavailable_and_never_quotes_the_secret() {
        let error = unavailable(keyring::Error::BadEncoding(b"hunter2\xff".to_vec()));
        assert_eq!(error.code, ErrorCode::Unreachable);
        assert_eq!(
            error.message,
            "The system keychain is not available (Password data is not valid UTF-8). Use a client certificate or no authentication."
        );
    }

    /// Spec I69. Runs only with `SKOPOS_KEYCHAIN_TEST=1`, which CI sets on macOS and Windows:
    /// Linux CI has no Secret Service.
    #[test]
    fn an_entry_is_set_read_replaced_and_deleted() {
        if std::env::var("SKOPOS_KEYCHAIN_TEST").as_deref() != Ok("1") {
            return;
        }
        let store = KeychainStore::new("SkoposIDE keychain test");
        let cluster = format!("test-{}", std::process::id());
        store.delete(&cluster).unwrap();
        assert_eq!(store.get(&cluster).unwrap(), None);
        store.set(&cluster, &Secret::new("first")).unwrap();
        assert_eq!(store.get(&cluster).unwrap(), Some(Secret::new("first")));
        store.set(&cluster, &Secret::new("second")).unwrap();
        assert_eq!(store.get(&cluster).unwrap(), Some(Secret::new("second")));
        store.delete(&cluster).unwrap();
        assert_eq!(store.get(&cluster).unwrap(), None);
        store.delete(&cluster).unwrap();
    }

    /// Review Focus 3: a locked keychain, a refused access or no store at all is "not
    /// available", with the platform's reason.
    #[test]
    fn a_locked_or_missing_keychain_is_unavailable_with_its_reason() {
        let cases = [
            (
                keyring::Error::NoStorageAccess(Box::new(std::io::Error::other(
                    "the keychain is locked",
                ))),
                "Couldn't access platform storage: the keychain is locked",
            ),
            (
                keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
                    "User interaction is not allowed.",
                ))),
                "Platform failure: User interaction is not allowed.",
            ),
            (
                keyring::Error::NoDefaultStore,
                "No default store has been set, so cannot search or create entries",
            ),
        ];
        for (error, reason) in cases {
            let error = unavailable(error);
            assert_eq!(error.code, ErrorCode::Unreachable);
            assert_eq!(
                error.message,
                format!(
                    "The system keychain is not available ({reason}). Use a client certificate or no authentication."
                )
            );
        }
    }
}
