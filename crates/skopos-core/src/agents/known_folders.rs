//! The folders agent CLIs and their ACP adapters are installed in, searched after `PATH`: the
//! login shell's `PATH` misses them when its environment could not be loaded, or when a version
//! manager adds its folder only in a terminal.

use std::path::{Path, PathBuf};

/// Under the home folder on every OS, in the order searched: Claude Code's native installer
/// (and pipx, uv), Claude Code's older local install, OpenCode's install script, Bun, npm's
/// suggested prefix for global installs without root, Volta, Yarn and Cargo.
const HOME_FOLDERS: [&str; 8] = [
    ".local/bin",
    ".claude/local",
    ".opencode/bin",
    ".bun/bin",
    ".npm-global/bin",
    ".volta/bin",
    ".yarn/bin",
    ".cargo/bin",
];

/// pnpm's global folder (`PNPM_HOME`'s default) on macOS and on Linux.
const MACOS_PNPM: &str = "Library/pnpm";
const LINUX_PNPM: &str = ".local/share/pnpm";

/// The Node versions of nvm and fnm, under the home folder: each version's own folder, then its
/// `bin` within. npm installs a global package beside the `node` of the version in use.
const NVM_VERSIONS: (&str, &str) = (".nvm/versions/node", "bin");
const FNM_VERSIONS: [(&str, &str); 2] = [
    (".local/share/fnm/node-versions", "installation/bin"),
    (".fnm/node-versions", "installation/bin"),
];
const MACOS_FNM_VERSIONS: (&str, &str) = (
    "Library/Application Support/fnm/node-versions",
    "installation/bin",
);

/// Homebrew's on Apple silicon, then on Intel Macs. A GUI app's `PATH` has neither.
const MACOS_SYSTEM_FOLDERS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// The known folders of this OS that exist, in the order searched.
pub fn known_folders(home: &Path) -> Vec<PathBuf> {
    known_folders_on(home, cfg!(target_os = "macos"))
}

/// The known folders that exist, for macOS or for Linux: the home folders, pnpm's, the Node
/// versions of nvm then fnm (newest first), then on macOS Homebrew's.
fn known_folders_on(home: &Path, macos: bool) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = HOME_FOLDERS
        .iter()
        .map(|folder| home.join(folder))
        .collect();
    folders.push(home.join(if macos { MACOS_PNPM } else { LINUX_PNPM }));
    let mut versions = vec![NVM_VERSIONS];
    if macos {
        versions.push(MACOS_FNM_VERSIONS);
    }
    versions.extend(FNM_VERSIONS);
    for (parent, bin) in versions {
        folders.extend(
            newest_first(&home.join(parent))
                .into_iter()
                .map(|version| version.join(bin)),
        );
    }
    if macos {
        folders.extend(MACOS_SYSTEM_FOLDERS.iter().map(PathBuf::from));
    }
    folders.retain(|folder| folder.is_dir());
    folders
}

/// The folders in `parent` named as versions (`v22.11.0`, `22.11.0`), newest first; the
/// others are left out.
fn newest_first(parent: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut versions: Vec<(Vec<u64>, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            Some((version_of(&name)?, entry.path()))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, path)| path).collect()
}

/// `v22.11.0` or `22.11.0` as numbers; `None` for any other name.
fn version_of(name: &str) -> Option<Vec<u64>> {
    let numbers = name.strip_prefix('v').unwrap_or(name);
    numbers
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<Vec<u64>>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(home: &Path, folders: &[&str]) {
        for folder in folders {
            std::fs::create_dir_all(home.join(folder)).unwrap();
        }
    }

    fn under(home: &Path, folders: &[PathBuf]) -> Vec<String> {
        folders
            .iter()
            .filter_map(|folder| folder.strip_prefix(home).ok())
            .map(|folder| folder.display().to_string())
            .collect()
    }

    #[test]
    fn the_linux_folders_that_exist_in_order_with_the_newest_node_first() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        make(
            home,
            &[
                ".cargo/bin",
                ".local/bin",
                ".opencode/bin",
                ".local/share/pnpm",
                ".nvm/versions/node/v9.11.2/bin",
                ".nvm/versions/node/v22.11.0/bin",
                ".nvm/versions/node/v20.18.1/bin",
                ".nvm/versions/node/system",
                ".local/share/fnm/node-versions/v22.12.0/installation/bin",
                "Library/pnpm",
            ],
        );

        let folders = known_folders_on(home, false);

        assert_eq!(
            under(home, &folders),
            [
                ".local/bin",
                ".opencode/bin",
                ".cargo/bin",
                ".local/share/pnpm",
                ".nvm/versions/node/v22.11.0/bin",
                ".nvm/versions/node/v20.18.1/bin",
                ".nvm/versions/node/v9.11.2/bin",
                ".local/share/fnm/node-versions/v22.12.0/installation/bin",
            ]
        );
        // Every folder is under the home folder on Linux.
        assert_eq!(folders.len(), 8);
    }

    #[test]
    fn macos_adds_its_pnpm_and_fnm_folders_then_homebrew() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        make(
            home,
            &[
                ".local/bin",
                "Library/pnpm",
                ".local/share/pnpm",
                "Library/Application Support/fnm/node-versions/v22.12.0/installation/bin",
            ],
        );

        let folders = known_folders_on(home, true);

        assert_eq!(
            under(home, &folders),
            [
                ".local/bin",
                "Library/pnpm",
                "Library/Application Support/fnm/node-versions/v22.12.0/installation/bin",
            ]
        );
        // Homebrew's folders follow, where this machine has them.
        let system: Vec<&PathBuf> = folders.iter().filter(|f| !f.starts_with(home)).collect();
        for folder in &system {
            assert!(MACOS_SYSTEM_FOLDERS.contains(&folder.to_str().unwrap()));
        }
        assert_eq!(folders.len() - system.len(), 3);
    }

    #[test]
    fn a_home_without_any_of_them_gives_none_on_linux() {
        let home = tempfile::tempdir().unwrap();
        assert!(known_folders_on(home.path(), false).is_empty());
    }

    #[test]
    fn versions_are_compared_as_numbers() {
        assert_eq!(version_of("v22.11.0"), Some(vec![22, 11, 0]));
        assert_eq!(version_of("18.20.4"), Some(vec![18, 20, 4]));
        assert_eq!(version_of("system"), None);
        assert_eq!(version_of("v22.x"), None);
        assert_eq!(version_of(""), None);
        assert!(version_of("v10.0.0") > version_of("v9.11.2"));
    }
}
