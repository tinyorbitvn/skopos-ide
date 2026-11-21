//! The Tauri updater plugin behind the core's `UpdateSource` (in-app update spec §5.2).

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use skopos_core::app_core::AppCore;
use skopos_core::error::{CoreResult, ErrorCode, IpcError};
use skopos_core::prefs::Prefs;
use skopos_core::updates::{BoxFuture, Package, Progress, Release, UpdateSource};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::state::AppState;

/// Automatic checks are off in debug and e2e builds; manual ones work everywhere (spec §5.2).
const AUTOMATIC: bool = !cfg!(debug_assertions) && !cfg!(feature = "e2e");
/// For the check only: the download clears it, so a slow link is not cut short.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

const CANNOT_SELF_UPDATE: &str = "This copy can't update itself.";
const MOVE_TO_APPLICATIONS: &str = "Move SkoposIDE to Applications to update it.";
const SIGNATURE_MISMATCH: &str = "The update's signature doesn't match, so it wasn't installed.";
const DEB_NOT_INSTALLED: &str =
    "The package was not installed. If you cancelled the password prompt, try again.";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `app`, `nsis`, `appimage` or `deb` for a bundle the plugin can update; `None` otherwise.
fn installer_name(bundle: Option<BundleType>) -> Option<&'static str> {
    match bundle? {
        BundleType::App | BundleType::Dmg => Some("app"),
        BundleType::Nsis => Some("nsis"),
        BundleType::AppImage => Some("appimage"),
        BundleType::Deb => Some("deb"),
        _ => None,
    }
}

/// Why this copy cannot install an update itself, or `None` when it can.
fn blocker_for(bundle: Option<BundleType>, exe: &Path) -> Option<&'static str> {
    let Some(installer) = installer_name(bundle) else {
        return Some(CANNOT_SELF_UPDATE);
    };
    let exe = exe.to_string_lossy();
    // The read-only disk image, and the read-only copy macOS runs a quarantined app from.
    if installer == "app" && (exe.starts_with("/Volumes/") || exe.contains("/AppTranslocation/")) {
        return Some(MOVE_TO_APPLICATIONS);
    }
    None
}

/// The Preferences proxy, which carries both the check and the download. `prefs_set` saves
/// only http and https URLs, so anything else is ignored.
fn proxy_url(prefs: &Prefs) -> Option<Url> {
    prefs
        .http_proxy
        .as_deref()
        .and_then(|proxy| Url::parse(proxy).ok())
}

/// The error and its causes on one line.
fn chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut text = err.to_string();
    let mut cause = err.source();
    while let Some(next) = cause {
        text.push_str(": ");
        text.push_str(&next.to_string());
        cause = next.source();
    }
    text
}

/// The plugin cannot tell a cancelled `pkexec` prompt from a failed `dpkg` (R6).
fn install_failure_message(installer: Option<&str>, detail: &str) -> String {
    if installer == Some("deb") {
        DEB_NOT_INSTALLED.to_owned()
    } else {
        format!("the update could not be installed: {detail}")
    }
}

fn signature_error(err: &tauri_plugin_updater::Error) -> Option<IpcError> {
    matches!(err, tauri_plugin_updater::Error::Minisign(_)).then(|| {
        tracing::warn!("an update's signature does not match: {}", chain(err));
        IpcError::new(ErrorCode::Internal, SIGNATURE_MISMATCH)
    })
}

fn check_error(err: tauri_plugin_updater::Error) -> IpcError {
    IpcError::new(
        ErrorCode::Unreachable,
        format!("cannot reach the update server: {}", chain(&err)),
    )
}

fn download_error(err: tauri_plugin_updater::Error) -> IpcError {
    signature_error(&err).unwrap_or_else(|| {
        IpcError::new(
            ErrorCode::Unreachable,
            format!("the update could not be downloaded: {}", chain(&err)),
        )
    })
}

fn release_of(update: &Update) -> Release {
    Release {
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        date: update.date.map(|date| date.unix_timestamp()),
    }
}

/// The plugin as the core's update source.
struct PluginSource {
    app: AppHandle,
    /// The update the last successful check found; `download` and `install` use it.
    found: Mutex<Option<Update>>,
}

impl PluginSource {
    fn core(&self) -> AppCore {
        self.app.state::<AppState>().core.clone()
    }

    fn updater(&self) -> tauri_plugin_updater::Result<Updater> {
        let mut builder = self.app.updater_builder().timeout(CHECK_TIMEOUT);
        if let Some(proxy) = proxy_url(&self.core().prefs_get()) {
            builder = builder.proxy(proxy);
        }
        // The e2e suite points the check at a local server (spec §8); release builds lack it.
        #[cfg(feature = "e2e")]
        {
            let endpoint = std::env::var("SKOPOS_E2E_UPDATE_ENDPOINT")
                .ok()
                .and_then(|url| Url::parse(&url).ok());
            if let Some(endpoint) = endpoint {
                builder = builder.endpoints(vec![endpoint])?;
            }
        }
        // The plugin replaces the file it is told is the app: for an AppImage, that file,
        // not the mount it runs from.
        if matches!(
            tauri::utils::platform::bundle_type(),
            Some(BundleType::AppImage)
        ) {
            if let Some(appimage) = std::env::var_os("APPIMAGE") {
                builder = builder.executable_path(appimage);
            }
        }
        #[cfg(windows)]
        {
            // The NSIS installer replaces the app: the process ends right after this hook.
            let app = self.app.clone();
            builder = builder.on_before_exit(move || {
                crate::windows::quitting(
                    &app,
                    "the installer replaces the app; the core shuts down",
                );
                let core = app.state::<AppState>().core.clone();
                tauri::async_runtime::block_on(core.shutdown());
            });
        }
        builder.build()
    }
}

impl UpdateSource for PluginSource {
    fn check(&self) -> BoxFuture<'_, CoreResult<Option<Release>>> {
        Box::pin(async move {
            let updater = self.updater().map_err(check_error)?;
            let found = updater.check().await.map_err(check_error)?;
            let release = found.as_ref().map(release_of);
            *lock(&self.found) = found;
            Ok(release)
        })
    }

    fn download(&self, mut progress: Progress) -> BoxFuture<'_, CoreResult<Package>> {
        Box::pin(async move {
            let found = lock(&self.found).clone();
            let mut update = found
                .ok_or_else(|| IpcError::new(ErrorCode::Conflict, "check for updates first"))?;
            // The check's timeout would cut a slow download short.
            update.timeout = None;
            let mut received = 0u64;
            let bytes = update
                .download(
                    |chunk, total| {
                        received += chunk as u64;
                        progress(received, total);
                    },
                    || {},
                )
                .await
                .map_err(download_error)?;
            Ok(Package {
                version: update.version.clone(),
                bytes,
            })
        })
    }

    fn install(&self, package: Package) -> CoreResult<()> {
        let update = lock(&self.found)
            .clone()
            .filter(|update| update.version == package.version)
            .ok_or_else(|| {
                IpcError::new(
                    ErrorCode::Conflict,
                    "the update changed while it downloaded; try again",
                )
            })?;
        // Every window saves its layout before the installer can end the process (R4).
        tauri::async_runtime::block_on(crate::windows::prepare_restart(&self.app));
        update.install(&package.bytes).map_err(|err| {
            signature_error(&err).unwrap_or_else(|| {
                let detail = chain(&err);
                tracing::warn!("the update was not installed: {detail}");
                let installer = self.installer();
                IpcError::new(
                    ErrorCode::Internal,
                    install_failure_message(installer.as_deref(), &detail),
                )
            })
        })
    }

    fn blocker(&self) -> Option<String> {
        let exe = std::env::current_exe().unwrap_or_default();
        blocker_for(tauri::utils::platform::bundle_type(), &exe).map(str::to_owned)
    }

    fn installer(&self) -> Option<String> {
        installer_name(tauri::utils::platform::bundle_type()).map(str::to_owned)
    }
}

/// Starts the core's update service with the plugin as its source.
pub fn start(app: &AppHandle, core: &AppCore) {
    let source = Arc::new(PluginSource {
        app: app.clone(),
        found: Mutex::new(None),
    });
    let core = core.clone();
    // The scheduler is a Tokio task, and `setup` runs outside the runtime.
    tauri::async_runtime::spawn(async move { core.updates_start(source, AUTOMATIC) });
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use skopos_core::prefs::Prefs;
    use tauri::utils::config::BundleType;

    use super::*;

    #[test]
    fn the_bundles_the_plugin_installs_can_update_themselves() {
        assert_eq!(installer_name(Some(BundleType::App)), Some("app"));
        assert_eq!(installer_name(Some(BundleType::Dmg)), Some("app"));
        assert_eq!(installer_name(Some(BundleType::Nsis)), Some("nsis"));
        assert_eq!(installer_name(Some(BundleType::AppImage)), Some("appimage"));
        assert_eq!(installer_name(Some(BundleType::Deb)), Some("deb"));
        assert_eq!(installer_name(Some(BundleType::Rpm)), None);
        assert_eq!(installer_name(Some(BundleType::Msi)), None);
        assert_eq!(installer_name(None), None);
    }

    #[test]
    fn a_copy_that_cannot_update_itself_says_why() {
        let app = || Some(BundleType::App);
        let exe = "SkoposIDE.app/Contents/MacOS/skopos-app";
        assert_eq!(
            blocker_for(app(), &Path::new("/Applications").join(exe)),
            None
        );
        assert_eq!(
            blocker_for(app(), &Path::new("/Volumes/SkoposIDE").join(exe)),
            Some(MOVE_TO_APPLICATIONS)
        );
        assert_eq!(
            blocker_for(
                app(),
                &Path::new("/private/var/folders/x1/T/AppTranslocation/5E2A/d").join(exe)
            ),
            Some(MOVE_TO_APPLICATIONS)
        );
        assert_eq!(
            blocker_for(
                None,
                Path::new("/home/me/src/skopos/target/debug/skopos-app")
            ),
            Some(CANNOT_SELF_UPDATE)
        );
        assert_eq!(
            blocker_for(
                Some(BundleType::AppImage),
                Path::new("/tmp/.mount_SkopoXy/usr/bin/skopos-app")
            ),
            None
        );
        assert_eq!(
            blocker_for(Some(BundleType::Deb), Path::new("/usr/bin/skopos-app")),
            None
        );
        assert_eq!(
            blocker_for(Some(BundleType::Rpm), Path::new("/usr/bin/skopos-app")),
            Some(CANNOT_SELF_UPDATE)
        );
    }

    #[test]
    fn the_preferences_proxy_carries_the_check_and_the_download() {
        let mut prefs = Prefs::default();
        assert_eq!(proxy_url(&prefs), None);
        prefs.http_proxy = Some("http://proxy.example:3128".into());
        assert_eq!(
            proxy_url(&prefs).map(|url| url.to_string()).as_deref(),
            Some("http://proxy.example:3128/")
        );
    }

    #[test]
    fn a_failed_deb_install_points_at_the_password_prompt() {
        assert_eq!(
            install_failure_message(Some("deb"), "dpkg exited with 1"),
            "The package was not installed. If you cancelled the password prompt, try again."
        );
        assert_eq!(
            install_failure_message(Some("appimage"), "permission denied"),
            "the update could not be installed: permission denied"
        );
    }
}
