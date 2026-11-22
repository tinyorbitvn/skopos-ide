//! What the person types in Preferences → Agent sandbox (agents spec §3.5): the domains
//! agents may reach and the folders they may read.

use std::path::{Path, PathBuf};

use crate::error::{CoreResult, ErrorCode, IpcError};

/// A domain with no dot, a space, a slash, a port or an address.
pub const DOMAIN_ERROR: &str = "Enter a domain such as example.com";
/// A folder that starts with neither `/` nor `~/`.
pub const FULL_PATH_ERROR: &str = "Enter a full path";
/// The home folder, or a folder that holds it: the sandbox hides the home folder (spec
/// §6.2), and an allowed folder would show it again.
pub const HOME_FOLDER_ERROR: &str =
    "Agents can't read your whole home folder. Pick a folder inside it";

/// `input` trimmed and in lower case, when it is a host name with a dot: labels of letters,
/// digits and `-`, none empty, the last not all digits (so no IPv4 address passes).
pub fn normalize_domain(input: &str) -> CoreResult<String> {
    let domain = input.trim().to_ascii_lowercase();
    let labels: Vec<&str> = domain.split('.').collect();
    let label_ok = |label: &&str| {
        !label.is_empty()
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    // No top-level domain is all digits.
    let numeric_end = labels
        .last()
        .is_some_and(|last| last.bytes().all(|b| b.is_ascii_digit()));
    if labels.len() < 2 || !labels.iter().all(label_ok) || numeric_end {
        return Err(IpcError::new(ErrorCode::InvalidInput, DOMAIN_ERROR));
    }
    Ok(domain)
}

/// `input` trimmed, as typed (`/x` or `~/x`) without its trailing slashes, when it names an
/// existing folder that is not the home folder and does not hold it.
pub fn normalize_folder(input: &str, home: &Path) -> CoreResult<String> {
    let typed = input.trim();
    if !(typed.starts_with('/') || typed.starts_with("~/")) {
        return Err(IpcError::new(ErrorCode::InvalidInput, FULL_PATH_ERROR));
    }
    let trimmed = typed.trim_end_matches('/');
    // `/` keeps its slash; `~/` becomes `~`, the home folder.
    let folder = if trimmed.is_empty() { "/" } else { trimmed };
    let path = expand_home(folder, home);
    if !path.is_dir() {
        return Err(IpcError::new(
            ErrorCode::InvalidInput,
            format!("No such folder: {typed}"),
        ));
    }
    if holds_home(&path, home) {
        return Err(IpcError::new(ErrorCode::InvalidInput, HOME_FOLDER_ERROR));
    }
    Ok(folder.to_owned())
}

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

/// Whether `folder` is `home` or holds it, once links and `..` are resolved.
fn holds_home(folder: &Path, home: &Path) -> bool {
    let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    real(home).starts_with(real(folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_domain_is_trimmed_and_lower_cased() {
        assert_eq!(
            normalize_domain(" Registry.NPMJS.org ").unwrap(),
            "registry.npmjs.org"
        );
        for good in [
            "example.com",
            "api.example.co.uk",
            "my-registry.example.com",
            "x1.io",
        ] {
            assert_eq!(normalize_domain(good).unwrap(), good);
        }
    }

    #[test]
    fn a_domain_needs_a_dot_and_no_space_slash_port_or_address() {
        for bad in [
            "",
            "localhost",
            "example com",
            "example.com/path",
            "https://example.com",
            "example.com:8443",
            "::1",
            "[::1]",
            "fe80::1",
            "10.0.0.1",
            "127.0.0.1",
            ".example.com",
            "example.com.",
            "example..com",
            "*.example.com",
            "user@example.com",
            "exämple.com",
        ] {
            let error = normalize_domain(bad).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{bad}");
            assert_eq!(error.message, DOMAIN_ERROR, "{bad}");
        }
    }

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

    /// A home folder in a temp dir with `code/` and a file in it, and `elsewhere/` beside it.
    #[cfg(unix)]
    fn layout() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(home.join("code")).unwrap();
        std::fs::write(home.join("notes.txt"), "").unwrap();
        std::fs::create_dir_all(root.path().join("elsewhere")).unwrap();
        (root, home)
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_keeps_its_typed_form_without_the_trailing_slash() {
        let (root, home) = layout();
        assert_eq!(normalize_folder(" ~/code/ ", &home).unwrap(), "~/code");
        assert_eq!(normalize_folder("~/code", &home).unwrap(), "~/code");
        let elsewhere = root.path().join("elsewhere").display().to_string();
        assert_eq!(
            normalize_folder(&format!("{elsewhere}//"), &home).unwrap(),
            elsewhere
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_is_a_full_path_to_an_existing_folder() {
        let (_root, home) = layout();
        let cases = [
            ("", FULL_PATH_ERROR),
            ("code", FULL_PATH_ERROR),
            ("./code", FULL_PATH_ERROR),
            ("~code", FULL_PATH_ERROR),
            ("~", FULL_PATH_ERROR),
            ("~/missing", "No such folder: ~/missing"),
            (" ~/notes.txt ", "No such folder: ~/notes.txt"),
        ];
        for (typed, message) in cases {
            let error = normalize_folder(typed, &home).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{typed}");
            assert_eq!(error.message, message, "{typed}");
        }
    }

    /// The sandbox hides the home folder; a folder that is it or holds it would show it again.
    #[cfg(unix)]
    #[test]
    fn the_home_folder_and_the_folders_that_hold_it_are_refused() {
        let (root, home) = layout();
        let parent = root.path().display().to_string();
        let full_home = home.display().to_string();
        let back_up = format!("{full_home}/code/..");
        for typed in [
            "~/",
            "/",
            parent.as_str(),
            full_home.as_str(),
            back_up.as_str(),
        ] {
            let error = normalize_folder(typed, &home).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{typed}");
            assert_eq!(error.message, HOME_FOLDER_ERROR, "{typed}");
        }
    }
}
