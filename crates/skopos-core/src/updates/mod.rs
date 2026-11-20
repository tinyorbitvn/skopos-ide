//! In-app updates (in-app update spec §5.1): the schedule, the state every window shows and
//! the rules. The app supplies an `UpdateSource` backed by the Tauri updater plugin; the
//! tests use a fake.

mod service;

pub use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use service::Updates;

use crate::app_core::AppCore;
use crate::error::CoreResult;

/// A release newer than the running one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Release {
    pub version: String,
    /// Markdown: the release's CHANGELOG notes.
    pub notes: String,
    /// When it was published, in Unix seconds.
    #[ts(type = "number | null")]
    pub date: Option<i64>,
}

/// Where the update flow is. The dialog and the status bar are drawn from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum UpdatePhase {
    /// No check has finished in this run.
    Idle,
    /// A check the user asked for. Automatic checks run unseen.
    Checking,
    UpToDate,
    Available {
        release: Release,
    },
    /// A manual check, a download or an install failed. `release` is the release being
    /// installed, so that Try Again can install it again; `None` for a failed check.
    Failed {
        message: String,
        release: Option<Release>,
    },
    Downloading {
        version: String,
        #[ts(type = "number")]
        received: u64,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    Installing {
        version: String,
    },
}

/// What every window shows, sent as one value after every change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateState {
    pub phase: UpdatePhase,
    /// The running version.
    pub current: String,
    /// Why this copy cannot install an update itself, in words for the user; `None` when
    /// it can.
    pub blocker: Option<String>,
    /// How this copy was installed: `app`, `nsis`, `appimage` or `deb`; `None` when unknown.
    pub installer: Option<String>,
    /// The version the user chose to skip.
    pub skipped: Option<String>,
    /// When a check last succeeded, in Unix seconds.
    #[ts(type = "number | null")]
    pub last_checked_at: Option<i64>,
    /// Set only on the change that announces a release an automatic check found for the
    /// first time: the window that shows the toast.
    pub toast_window: Option<String>,
}

/// What `updates.json` keeps between runs. Settings does not show it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateMemory {
    pub skipped_version: Option<String>,
    pub notified_version: Option<String>,
    pub last_checked_at: Option<i64>,
}

/// A downloaded update whose signature was verified.
pub struct Package {
    pub version: String,
    pub bytes: Vec<u8>,
}

/// Download progress: the bytes received so far, and the total when the server sent it.
pub type Progress = Box<dyn FnMut(u64, Option<u64>) + Send>;

/// The update server and the installer. `skopos-app` implements it with the Tauri updater
/// plugin.
pub trait UpdateSource: Send + Sync + 'static {
    /// Asks the server for a release newer than the running version.
    fn check(&self) -> BoxFuture<'_, CoreResult<Option<Release>>>;
    /// Downloads the release the last successful `check` found and verifies its signature.
    fn download(&self, progress: Progress) -> BoxFuture<'_, CoreResult<Package>>;
    /// Installs a package. It blocks, so the core calls it on a blocking thread. On Windows
    /// it does not return: the installer replaces the app.
    fn install(&self, package: Package) -> CoreResult<()>;
    /// Why this copy cannot update itself, in words for the user; `None` when it can.
    fn blocker(&self) -> Option<String>;
    /// `app`, `nsis`, `appimage` or `deb`; `None` when the copy was not installed from one.
    fn installer(&self) -> Option<String>;
}

impl AppCore {
    pub fn update_state(&self) -> UpdateState {
        self.updates().state()
    }

    /// A check the user asked for: from the menu, the palette or Settings.
    pub async fn update_check(&self) -> UpdateState {
        self.updates().check_now().await
    }

    /// Downloads, verifies and installs the available release; the app restarts on `Ok`.
    pub async fn update_install(&self) -> CoreResult<()> {
        self.updates().install().await
    }

    pub fn update_cancel(&self) {
        self.updates().cancel();
    }

    pub fn update_skip(&self, version: String) -> CoreResult<()> {
        self.updates().skip(version)
    }
}
