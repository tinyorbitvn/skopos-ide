//! How this copy was installed: from the Microsoft Store as an MSIX package, or directly
//! (Store spec §3). Only Windows has packages; other OSes are always `Direct`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallChannel {
    Direct,
    MicrosoftStore,
}

impl InstallChannel {
    /// The word in the startup log line `install channel: …`, which the MSIX install check reads.
    pub fn label(self) -> &'static str {
        match self {
            InstallChannel::Direct => "direct",
            InstallChannel::MicrosoftStore => "microsoft-store",
        }
    }
}

/// `ERROR_INSUFFICIENT_BUFFER`: the process has a package name that did not fit an empty buffer.
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
/// `APPMODEL_ERROR_NO_PACKAGE`: the process has no package identity.
#[cfg(any(not(windows), test))]
const APPMODEL_ERROR_NO_PACKAGE: u32 = 15700;

/// How this copy was installed, asked of Windows once at startup.
pub fn detect() -> InstallChannel {
    channel_for(package_name_result())
}

/// What `GetCurrentPackageFullName` with an empty buffer says about the process. Only a name
/// that did not fit means a package; `APPMODEL_ERROR_NO_PACKAGE` and any other result mean a
/// direct install, whose updater then works as before.
fn channel_for(result: u32) -> InstallChannel {
    if result == ERROR_INSUFFICIENT_BUFFER {
        InstallChannel::MicrosoftStore
    } else {
        InstallChannel::Direct
    }
}

#[cfg(windows)]
fn package_name_result() -> u32 {
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut length: u32 = 0;
    // SAFETY: with a zero length Windows writes only `length` and never touches the null buffer.
    unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) }
}

/// Only Windows has packages. Going through `channel_for` on every OS keeps it and both
/// variants in use, so clippy finds no dead code on Linux or macOS.
#[cfg(not(windows))]
fn package_name_result() -> u32 {
    APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_package_name_that_did_not_fit_means_the_store() {
        assert_eq!(
            channel_for(ERROR_INSUFFICIENT_BUFFER),
            InstallChannel::MicrosoftStore
        );
        assert_eq!(
            channel_for(APPMODEL_ERROR_NO_PACKAGE),
            InstallChannel::Direct
        );
        assert_eq!(channel_for(0), InstallChannel::Direct);
        assert_eq!(channel_for(87), InstallChannel::Direct);
    }

    #[test]
    fn labels_match_the_install_check() {
        assert_eq!(InstallChannel::Direct.label(), "direct");
        assert_eq!(InstallChannel::MicrosoftStore.label(), "microsoft-store");
    }

    #[test]
    fn a_process_started_by_cargo_test_has_no_package() {
        assert_eq!(detect(), InstallChannel::Direct);
    }
}
