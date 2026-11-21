use std::path::{Path, PathBuf};

use crate::error::{CoreResult, ErrorCode, IpcError};

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub logs: PathBuf,
    pub cache: PathBuf,
    pub home: PathBuf,
}

impl AppPaths {
    /// `SKOPOS_CONFIG_DIR` (when set and non-empty) roots everything; otherwise
    /// the platform directories for qualifier `dev.skopos` are used.
    pub fn resolve() -> CoreResult<AppPaths> {
        let override_root = std::env::var_os("SKOPOS_CONFIG_DIR").filter(|v| !v.is_empty());
        // `directories` ignores USERPROFILE on Windows, so a test home must come from the env.
        let env_home = || {
            let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            std::env::var_os(var)
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
                .map(PathBuf::from)
        };
        let base_home = || directories::BaseDirs::new().map(|d| d.home_dir().to_path_buf());
        let home = if override_root.is_some() {
            env_home().or_else(base_home)
        } else {
            base_home().or_else(env_home)
        }
        .ok_or_else(|| IpcError::new(ErrorCode::Internal, "cannot determine home directory"))?;
        if let Some(root) = override_root {
            return Ok(Self::under(Path::new(&root), &home));
        }
        let dirs =
            directories::ProjectDirs::from("dev", "skopos", "SkoposIDE").ok_or_else(|| {
                IpcError::new(
                    ErrorCode::Internal,
                    "cannot determine application directories",
                )
            })?;
        let data = dirs.data_dir().to_path_buf();
        Ok(AppPaths {
            config: dirs.config_dir().to_path_buf(),
            logs: data.join("logs"),
            data,
            cache: dirs.cache_dir().to_path_buf(),
            home,
        })
    }

    /// Layout used by tests and `SKOPOS_CONFIG_DIR`; creates nothing.
    pub fn under(root: &Path, home: &Path) -> AppPaths {
        AppPaths {
            config: root.join("config"),
            data: root.join("data"),
            logs: root.join("logs"),
            cache: root.join("cache"),
            home: home.to_path_buf(),
        }
    }

    pub fn ensure_dirs(&self) -> CoreResult<()> {
        for dir in [&self.config, &self.data, &self.logs, &self.cache] {
            std::fs::create_dir_all(dir).map_err(|e| {
                let mut err = IpcError::from(e);
                // Shown to the user when the app cannot start, where the bare OS error says too little.
                err.message = format!("cannot create {}: {}", dir.display(), err.message);
                err
            })?;
            // A file system without modes refuses this, which is no reason not to start.
            if let Err(e) = keep_to_owner(dir) {
                tracing::warn!("cannot keep {} to its owner: {e}", dir.display());
            }
        }
        Ok(())
    }
}

/// Creates the directory, and its parents, and keeps it to its owner. A directory that
/// exists is closed as well.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    keep_to_owner(dir)
}

/// Where the system has file modes, takes the directory away from the machine's other
/// accounts: the app's folders hold settings, kubeconfig copies and log lines that name
/// clusters and their objects. It only takes away, so a directory its owner made
/// read-only stays read-only.
fn keep_to_owner(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir)?.permissions().mode() & 0o7777;
        let kept = mode & 0o7700;
        if kept != mode {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(kept))?;
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_creates_nothing_and_ensure_dirs_creates_all() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let p = AppPaths::under(&root.path().join("r"), &home);
        assert!(!p.config.exists());
        p.ensure_dirs().unwrap();
        assert!(p.config.is_dir() && p.data.is_dir() && p.logs.is_dir() && p.cache.is_dir());
        assert_eq!(p.home, home);
    }

    #[cfg(unix)]
    fn mode(dir: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(dir).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn ensure_dirs_keeps_every_folder_to_its_owner() {
        let root = tempfile::tempdir().unwrap();
        let p = AppPaths::under(&root.path().join("r"), root.path());

        p.ensure_dirs().unwrap();

        for dir in [&p.config, &p.data, &p.logs, &p.cache] {
            assert_eq!(mode(dir), 0o700, "{}", dir.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn ensure_dirs_closes_folders_an_earlier_version_left_open() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let p = AppPaths::under(&root.path().join("r"), root.path());
        for dir in [&p.config, &p.data, &p.logs, &p.cache] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        p.ensure_dirs().unwrap();

        for dir in [&p.config, &p.data, &p.logs, &p.cache] {
            assert_eq!(mode(dir), 0o700, "{}", dir.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn ensure_dirs_does_not_reopen_a_folder_its_owner_closed() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let p = AppPaths::under(&root.path().join("r"), root.path());
        std::fs::create_dir_all(&p.config).unwrap();
        std::fs::set_permissions(&p.config, std::fs::Permissions::from_mode(0o550)).unwrap();

        p.ensure_dirs().unwrap();

        // Still read-only for its owner, and no longer open to the group.
        assert_eq!(mode(&p.config), 0o500);
    }

    #[test]
    fn ensure_dirs_failure_names_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let blocker = root.path().join("file");
        std::fs::write(&blocker, "").unwrap();
        let p = AppPaths::under(&blocker, root.path());

        let err = p.ensure_dirs().unwrap_err();

        assert!(err.message.contains("config"), "{}", err.message);
    }

    #[test]
    fn env_override_roots_everything() {
        let root = tempfile::tempdir().unwrap();
        // Only test in this crate touching SKOPOS_CONFIG_DIR.
        std::env::set_var("SKOPOS_CONFIG_DIR", root.path());
        let p = AppPaths::resolve().unwrap();
        std::env::remove_var("SKOPOS_CONFIG_DIR");
        assert!(p.config.starts_with(root.path()));
        assert!(p.data.starts_with(root.path()));
        assert!(p.logs.starts_with(root.path()));
        assert!(p.cache.starts_with(root.path()));
    }
}
