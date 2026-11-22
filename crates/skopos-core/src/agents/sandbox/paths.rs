//! Where an agent's install lies, the interpreter a script names, and the kubeconfig files the
//! app knows (spec §4.6). The sandbox lets the agent read its install and hides those files.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::kubeconfig::SyncSource;
use crate::tools::find_on_path;

/// How much of a file is read to find its `#!` line.
const FIRST_LINE_LIMIT: u64 = 512;

/// The folder the sandbox shows for an installed file, found from the file's real path: the
/// npm package it belongs to when it lies in a `node_modules` folder, since the package's code
/// and dependencies sit around it; the folder above `bin/` when it sits in a `bin/`; else its
/// own folder.
pub fn install_root(path: &Path) -> PathBuf {
    let real = real_path(path);
    if let Some(package) = node_package(&real) {
        return package;
    }
    let Some(folder) = real.parent() else {
        return real;
    };
    match (folder.file_name(), folder.parent()) {
        (Some(name), Some(above)) if name == "bin" => above.to_path_buf(),
        _ => folder.to_path_buf(),
    }
}

/// The path with every link resolved, or the path itself when it cannot be resolved, as for a
/// path that does not exist.
pub fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `<prefix>/node_modules/<name>` or `<prefix>/node_modules/@<scope>/<name>` above `path`, at the path's first
/// `node_modules`, so a package's own dependencies come with it.
fn node_package(path: &Path) -> Option<PathBuf> {
    let components: Vec<Component<'_>> = path.components().collect();
    let at = components
        .iter()
        .position(|component| component.as_os_str() == "node_modules")?;
    let name = components.get(at + 1)?;
    let scoped = name.as_os_str().to_string_lossy().starts_with('@');
    let end = if scoped { at + 3 } else { at + 2 };
    // The package is a folder above the file, never the file itself.
    if end >= components.len() {
        return None;
    }
    Some(components[..end].iter().collect())
}

/// The interpreter a script's `#!` line names: the path itself (`#!/usr/bin/python3`), or for
/// `#!/usr/bin/env <name>` the `<name>` found on `path_var`. `None` for a file without such a
/// line, as a native program is.
pub fn interpreter_of(script: &Path, path_var: Option<&OsStr>) -> Option<PathBuf> {
    let mut head = Vec::new();
    std::fs::File::open(script)
        .ok()?
        .take(FIRST_LINE_LIMIT)
        .read_to_end(&mut head)
        .ok()?;
    let line = head
        .strip_prefix(b"#!")?
        .split(|byte| *byte == b'\n')
        .next()?;
    let mut words = std::str::from_utf8(line).ok()?.split_whitespace();
    let first = words.next()?;
    if !first.starts_with('/') {
        return None;
    }
    if Path::new(first).file_name() != Some(OsStr::new("env")) {
        return Some(PathBuf::from(first));
    }
    // `env -S node --flag` and `env NAME=value node`: the first word that is neither.
    let name = words.find(|word| !word.starts_with('-') && !word.contains('='))?;
    find_on_path(name, path_var)
}

/// Every kubeconfig file the app knows, each once, in this order: the files directly in each
/// `Dir` source and each `File` source, in the sources' order; the catalog's paths; the entries
/// of `KUBECONFIG`. Whether they exist is not checked here.
pub fn kubeconfig_files(
    sources: &[SyncSource],
    catalog: &[PathBuf],
    kubeconfig_env: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut add = |path: PathBuf| {
        if !files.contains(&path) {
            files.push(path);
        }
    };
    for source in sources {
        match source {
            SyncSource::File(path) => add(PathBuf::from(path)),
            SyncSource::Dir(path) => {
                for file in files_in(Path::new(path)) {
                    add(file);
                }
            }
        }
    }
    for path in catalog {
        add(path.clone());
    }
    for path in kubeconfig_env.into_iter().flat_map(std::env::split_paths) {
        if !path.as_os_str().is_empty() {
            add(path);
        }
    }
    files
}

/// The files directly in `dir`, by name, whatever their names: the sync skips some names, but
/// such files can still hold credentials.
fn files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(items) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = items
        .filter_map(Result::ok)
        .map(|item| item.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::kubeconfig::SyncSource;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A temp folder and its real path, which is how `install_root` gives paths.
    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = real_path(dir.path());
        (dir, root)
    }

    #[test]
    fn a_file_in_a_bin_folder_has_the_folder_above_as_its_root() {
        let (_dir, root) = root();
        let tool = root.join("opt/tool/bin/tool");
        write(&tool, "");
        assert_eq!(install_root(&tool), root.join("opt/tool"));
    }

    #[test]
    fn a_file_elsewhere_has_its_own_folder_as_its_root() {
        let (_dir, root) = root();
        let claude = root.join("share/claude/versions/2.1.0");
        write(&claude, "");
        assert_eq!(install_root(&claude), root.join("share/claude/versions"));
    }

    #[test]
    fn a_file_in_node_modules_has_its_package_as_its_root() {
        let (_dir, root) = root();
        let plain = root.join("lib/node_modules/opencode-ai/bin/opencode");
        let scoped =
            root.join("lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        write(&plain, "");
        write(&scoped, "");
        assert_eq!(
            install_root(&plain),
            root.join("lib/node_modules/opencode-ai")
        );
        assert_eq!(
            install_root(&scoped),
            root.join("lib/node_modules/@agentclientprotocol/claude-agent-acp")
        );
    }

    #[test]
    fn a_missing_file_keeps_its_own_path() {
        assert_eq!(
            install_root(Path::new("/nonexistent-skopos/tool/bin/tool")),
            PathBuf::from("/nonexistent-skopos/tool")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_followed_to_the_real_file() {
        let (_dir, root) = root();
        // Claude's own install: a link in a bin folder to one file per version.
        let claude = root.join("share/claude/versions/2.1.0");
        write(&claude, "");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::os::unix::fs::symlink(&claude, root.join("bin/claude")).unwrap();
        assert_eq!(
            install_root(&root.join("bin/claude")),
            root.join("share/claude/versions")
        );
        // npm's relative link in bin/ to the package's script.
        let script = root.join("lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js");
        write(&script, "");
        std::os::unix::fs::symlink(
            "../lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
            root.join("bin/codex-acp"),
        )
        .unwrap();
        assert_eq!(
            install_root(&root.join("bin/codex-acp")),
            root.join("lib/node_modules/@agentclientprotocol/codex-acp")
        );
    }

    #[test]
    fn an_absolute_interpreter_comes_from_the_first_line() {
        let (_dir, root) = root();
        let script = root.join("tool.py");
        write(&script, "#!/usr/bin/python3 -u\nprint(1)\n");
        assert_eq!(
            interpreter_of(&script, None),
            Some(PathBuf::from("/usr/bin/python3"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_env_interpreter_is_looked_up_on_the_path() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = root();
        let node = root.join("node/bin/node");
        write(&node, "");
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([root.join("node/bin")]).unwrap();
        let script = root.join("index.js");
        for line in [
            "#!/usr/bin/env node",
            "#!/usr/bin/env -S node --no-warnings",
            "#!/usr/bin/env NODE_OPTIONS=--trace-warnings node",
        ] {
            write(&script, &format!("{line}\nconsole.log(1)\n"));
            assert_eq!(
                interpreter_of(&script, Some(path.as_os_str())),
                Some(node.clone()),
                "{line}"
            );
        }
        write(&script, "#!/usr/bin/env no-such-interpreter\n");
        assert_eq!(interpreter_of(&script, Some(path.as_os_str())), None);
    }

    #[test]
    fn a_file_without_an_absolute_hash_bang_line_has_no_interpreter() {
        let (_dir, root) = root();
        let program = root.join("program");
        write(&program, "\u{7f}ELF\u{2}\u{1}");
        assert_eq!(interpreter_of(&program, None), None);
        write(&program, "#!node\n");
        assert_eq!(interpreter_of(&program, None), None);
        assert_eq!(interpreter_of(&root.join("missing"), None), None);
    }

    #[test]
    fn kubeconfig_files_lists_each_file_of_every_source_once() {
        let (_dir, root) = root();
        for name in [
            "kube/config",
            "kube/other.yaml",
            "kube/.hidden",
            "kube/nested/config",
            "one",
            "two",
            "three",
        ] {
            write(&root.join(name), "");
        }
        let text = |path: PathBuf| path.display().to_string();
        let sources = [
            SyncSource::Dir(text(root.join("kube"))),
            SyncSource::File(text(root.join("one"))),
            SyncSource::Dir(text(root.join("no-such-dir"))),
        ];
        let catalog = [root.join("two"), root.join("one")];
        let kubeconfig_env =
            std::env::join_paths([root.join("three"), PathBuf::new(), root.join("kube/config")])
                .unwrap();
        assert_eq!(
            kubeconfig_files(&sources, &catalog, Some(kubeconfig_env.as_os_str())),
            [
                root.join("kube/.hidden"),
                root.join("kube/config"),
                root.join("kube/other.yaml"),
                root.join("one"),
                root.join("two"),
                root.join("three"),
            ]
        );
    }
}
