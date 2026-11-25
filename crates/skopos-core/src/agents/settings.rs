//! Paths the person types for agents: a custom agent's command or a known install folder may
//! start with `~/`.

use std::path::{Path, PathBuf};

/// `~` is `home` and `~/x` is `home/x`; any other path is kept.
pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unix paths: on Windows `/home/me` is not absolute.
    #[cfg(unix)]
    #[test]
    fn a_tilde_path_expands_under_the_home_folder() {
        let home = Path::new("/home/me");
        assert_eq!(expand_home("~", home), PathBuf::from("/home/me"));
        assert_eq!(
            expand_home("~/code/app", home),
            PathBuf::from("/home/me/code/app")
        );
        assert_eq!(
            expand_home("/srv/manifests", home),
            PathBuf::from("/srv/manifests")
        );
        assert_eq!(
            expand_home("~other/code", home),
            PathBuf::from("~other/code")
        );
    }
}
