//! What one chat's sandbox allows (spec §4.6): the agent's folder, its settings and a temporary
//! folder read-write; its install, the app binary and the person's folders read-only; and the
//! kubeconfig files the app knows hidden wherever the home folder's cover does not reach them.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

use super::paths::{install_root, interpreter_of, real_path};
use crate::agents::registry::AgentSpec;

/// The proxy's socket in a chat's `run_dir` (Linux), bound into the sandbox at `/run/skopos`.
pub const PROXY_SOCKET: &str = "proxy.sock";
/// The MCP endpoint's socket in a chat's `run_dir` (Linux).
pub const MCP_SOCKET: &str = "mcp.sock";
/// System folders that hold other programs' files and sockets, which the Linux sandbox gives an
/// empty tmpfs as it does the home folder.
pub const EMPTY_FOLDERS: [&str; 3] = ["/tmp", "/run", "/var/tmp"];

/// The local ports of a chat's proxy and MCP endpoint as the agent reaches them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatPorts {
    pub proxy: u16,
    pub mcp: u16,
}

impl ChatPorts {
    /// Where `--agent-init` listens inside the Linux sandbox's own network namespace (R3).
    pub const LINUX_SANDBOX: ChatPorts = ChatPorts {
        proxy: 3128,
        mcp: 3129,
    };
}

/// One chat's sandbox. The caller creates `agent_dir`, `run_dir` (`0700`) and `tmp_dir`
/// before the agent starts.
#[derive(Clone, PartialEq, Eq)]
pub struct SandboxSpec {
    /// The agent's folder, read-write, and its working directory.
    pub agent_dir: PathBuf,
    /// The chat's runtime folder: on Linux it holds `proxy.sock` and `mcp.sock`.
    pub run_dir: PathBuf,
    /// `run_dir/tmp`, the agent's `TMPDIR`.
    pub tmp_dir: PathBuf,
    pub home: PathBuf,
    pub read_write: Vec<PathBuf>,
    pub read_only: Vec<PathBuf>,
    /// Kubeconfig files by their real paths, covered although the rest of the system shows.
    pub hidden_files: Vec<PathBuf>,
    /// The agent's whole environment.
    pub env: Vec<(String, String)>,
    /// The app's own binary, for `--agent-init` and `--agent-mcp`.
    pub app_binary: PathBuf,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Shows the names of the environment variables, never their values: they hold the chat's
/// token and provider keys.
impl fmt::Debug for SandboxSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let env: Vec<&str> = self.env.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("SandboxSpec")
            .field("agent_dir", &self.agent_dir)
            .field("run_dir", &self.run_dir)
            .field("tmp_dir", &self.tmp_dir)
            .field("home", &self.home)
            .field("read_write", &self.read_write)
            .field("read_only", &self.read_only)
            .field("hidden_files", &self.hidden_files)
            .field("env", &env)
            .field("app_binary", &self.app_binary)
            .field("program", &self.program)
            .field("args", &self.args)
            .finish()
    }
}

/// What `build_spec` needs to know about one chat.
pub struct SpecInput<'a> {
    pub agent: &'a AgentSpec,
    pub agent_dir: PathBuf,
    pub run_dir: PathBuf,
    pub home: &'a Path,
    /// The person's folders, expanded to full paths.
    pub folders: Vec<PathBuf>,
    /// From `paths::kubeconfig_files`.
    pub kubeconfigs: Vec<PathBuf>,
    pub app_binary: PathBuf,
    /// The `PATH` that `#!/usr/bin/env` lines are resolved on.
    pub path_var: Option<OsString>,
    /// From `env::agent_env`.
    pub env: Vec<(String, String)>,
}

/// The sandbox of one chat:
/// - read-write: the agent's folder, its settings paths that exist, and `run_dir/tmp`;
/// - read-only: the install roots of the agent's install paths, of the interpreters their `#!`
///   lines name, and of the app binary, then the person's folders;
/// - hidden: the kubeconfig files that exist and lie outside the home folder, or inside a path
///   the agent may read.
///
/// A path that holds the home folder or one of `EMPTY_FOLDERS`, such as an install root of `/`
/// or a folder `/home`, is left out: showing it would undo their cover. The program runs from
/// its real path, which the install roots show.
pub fn build_spec(input: SpecInput<'_>) -> SandboxSpec {
    let SpecInput {
        agent,
        agent_dir,
        run_dir,
        home,
        folders,
        kubeconfigs,
        app_binary,
        path_var,
        env,
    } = input;
    let covered = covered_folders(home);
    let tmp_dir = run_dir.join("tmp");
    let mut read_write = vec![agent_dir.clone()];
    for settings in agent.settings.iter().filter(|path| path.exists()) {
        allow(&mut read_write, settings.clone(), &covered);
    }
    read_write.push(tmp_dir.clone());
    let mut read_only = Vec::new();
    for installed in agent
        .install_paths
        .iter()
        .chain(std::iter::once(&app_binary))
    {
        allow(&mut read_only, install_root(installed), &covered);
        if let Some(interpreter) = interpreter_of(installed, path_var.as_deref()) {
            allow(&mut read_only, install_root(&interpreter), &covered);
        }
    }
    for folder in folders {
        allow(&mut read_only, folder, &covered);
    }
    let allowed: Vec<&PathBuf> = read_write.iter().chain(&read_only).collect();
    let hidden_files = hidden_files(&kubeconfigs, home, &allowed);
    SandboxSpec {
        agent_dir,
        run_dir,
        tmp_dir,
        home: home.to_path_buf(),
        read_write,
        read_only,
        hidden_files,
        env,
        app_binary,
        program: real_path(&agent.program),
        args: agent.args.clone(),
    }
}

/// The home folder and `EMPTY_FOLDERS`, as given and by their real paths.
fn covered_folders(home: &Path) -> Vec<PathBuf> {
    let mut covered = vec![home.to_path_buf(), real_path(home)];
    for folder in EMPTY_FOLDERS {
        covered.push(PathBuf::from(folder));
        covered.push(real_path(Path::new(folder)));
    }
    covered
}

/// Adds `path` once, unless it holds one of the covered folders.
fn allow(list: &mut Vec<PathBuf>, path: PathBuf, covered: &[PathBuf]) {
    let real = real_path(&path);
    if covered
        .iter()
        .any(|folder| folder.starts_with(&path) || folder.starts_with(&real))
    {
        tracing::warn!(
            "{} holds the home folder or a temporary folder, so the agent sandbox leaves it out",
            path.display()
        );
        return;
    }
    if !list.contains(&path) {
        list.push(path);
    }
}

/// The real paths of the kubeconfig files that exist and lie outside the home folder, or inside
/// a path the agent may read.
fn hidden_files(kubeconfigs: &[PathBuf], home: &Path, allowed: &[&PathBuf]) -> Vec<PathBuf> {
    let homes = [home.to_path_buf(), real_path(home)];
    let allowed: Vec<PathBuf> = allowed.iter().map(|path| real_path(path)).collect();
    let mut hidden: Vec<PathBuf> = Vec::new();
    for file in kubeconfigs {
        let real = real_path(file);
        if !real.is_file() || hidden.contains(&real) {
            continue;
        }
        let in_home = homes.iter().any(|home| real.starts_with(home));
        let in_allowed = allowed.iter().any(|path| real.starts_with(path));
        if !in_home || in_allowed {
            hidden.push(real);
        }
    }
    hidden
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::agents::registry::AgentSpec;
    use crate::agents::sandbox::paths::{kubeconfig_files, real_path};
    use crate::agents::sandbox::test_agent;
    use crate::kubeconfig::SyncSource;

    struct Layout {
        _dir: tempfile::TempDir,
        root: PathBuf,
        home: PathBuf,
    }

    fn layout() -> Layout {
        let dir = tempfile::tempdir().unwrap();
        let root = real_path(dir.path());
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        Layout {
            _dir: dir,
            root,
            home,
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A chat's input: the agent's folders under `root/data`, the app at
    /// `root/app/bin/skopos-ide`, one variable, no folders and no kubeconfig files.
    fn input<'a>(agent: &'a AgentSpec, layout: &'a Layout) -> SpecInput<'a> {
        SpecInput {
            agent,
            agent_dir: layout.root.join("data/agents/work/probe"),
            run_dir: layout.root.join("data/agents/run/0a1b2c3d"),
            home: &layout.home,
            folders: Vec::new(),
            kubeconfigs: Vec::new(),
            app_binary: layout.root.join("app/bin/skopos-ide"),
            path_var: None,
            env: vec![("TERM".to_owned(), "dumb".to_owned())],
        }
    }

    #[test]
    fn the_agent_gets_its_folder_its_existing_settings_and_a_tmp_folder_read_write() {
        let layout = layout();
        let mut agent = test_agent(&layout.root.join("agent/bin/agent"));
        agent.args = vec!["--acp".to_owned()];
        agent.settings = vec![
            layout.home.join(".claude"),
            layout.home.join(".claude.json"),
            layout.home.join(".config/anthropic"),
        ];
        std::fs::create_dir_all(layout.home.join(".claude")).unwrap();
        write(&layout.home.join(".claude.json"), "{}");
        let spec = build_spec(input(&agent, &layout));
        let work = layout.root.join("data/agents/work/probe");
        let run = layout.root.join("data/agents/run/0a1b2c3d");
        assert_eq!(spec.agent_dir, work);
        assert_eq!(spec.run_dir, run);
        assert_eq!(spec.tmp_dir, run.join("tmp"));
        assert_eq!(spec.home, layout.home);
        assert_eq!(
            spec.read_write,
            [
                work,
                layout.home.join(".claude"),
                layout.home.join(".claude.json"),
                run.join("tmp"),
            ]
        );
        assert_eq!(spec.env, [("TERM".to_owned(), "dumb".to_owned())]);
        assert_eq!(spec.args, ["--acp"]);
        assert_eq!(spec.app_binary, layout.root.join("app/bin/skopos-ide"));
    }

    #[cfg(unix)]
    #[test]
    fn install_roots_of_the_agent_its_interpreter_and_the_app_are_read_only_with_the_persons_folders(
    ) {
        use std::os::unix::fs::PermissionsExt;
        let layout = layout();
        let root = &layout.root;
        let script =
            root.join("npm/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        write(&script, "#!/usr/bin/env node\n");
        let node = root.join("node/bin/node");
        write(&node, "");
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cli = root.join("claude/versions/2.1.0");
        write(&cli, "");
        write(&root.join("app/bin/skopos-ide"), "");
        std::fs::create_dir_all(root.join("shop")).unwrap();
        let mut agent = test_agent(&script);
        agent.install_paths = vec![script.clone(), cli];
        let mut chat = input(&agent, &layout);
        chat.path_var = Some(std::env::join_paths([root.join("node/bin")]).unwrap());
        chat.folders = vec![root.join("shop")];
        let spec = build_spec(chat);
        assert_eq!(
            spec.read_only,
            [
                root.join("npm/lib/node_modules/@agentclientprotocol/claude-agent-acp"),
                root.join("node"),
                root.join("claude/versions"),
                root.join("app"),
                root.join("shop"),
            ]
        );
        assert_eq!(spec.program, script);
    }

    #[test]
    fn kubeconfig_files_outside_home_are_covered() {
        let layout = layout();
        let (root, home) = (&layout.root, &layout.home);
        for file in [
            home.join(".kube/config"),
            root.join("etc/skopos-test/config"),
            root.join("etc/skopos-test/dir/a"),
            root.join("etc/skopos-test/dir/b"),
            root.join("catalog/pasted.yaml"),
            root.join("env/config"),
        ] {
            write(&file, "kubeconfig");
        }
        let text = |path: PathBuf| path.display().to_string();
        let sources = [
            SyncSource::Dir(text(home.join(".kube"))),
            SyncSource::File(text(root.join("etc/skopos-test/config"))),
            SyncSource::Dir(text(root.join("etc/skopos-test/dir"))),
        ];
        let kubeconfig_env =
            std::env::join_paths([root.join("env/config"), root.join("missing/config")]).unwrap();
        let agent = test_agent(&root.join("agent/bin/agent"));
        let mut chat = input(&agent, &layout);
        chat.kubeconfigs = kubeconfig_files(
            &sources,
            &[root.join("catalog/pasted.yaml")],
            Some(kubeconfig_env.as_os_str()),
        );
        let spec = build_spec(chat);
        // `~/.kube/config` is covered with the rest of the home folder; a missing file needs nothing.
        assert_eq!(
            spec.hidden_files,
            [
                root.join("etc/skopos-test/config"),
                root.join("etc/skopos-test/dir/a"),
                root.join("etc/skopos-test/dir/b"),
                root.join("catalog/pasted.yaml"),
                root.join("env/config"),
            ]
        );
    }

    #[test]
    fn a_kubeconfig_in_a_folder_the_agent_may_read_is_covered() {
        let layout = layout();
        write(&layout.home.join("src/shop/kubeconfig"), "kubeconfig");
        write(&layout.home.join(".kube/config"), "kubeconfig");
        let agent = test_agent(&layout.root.join("agent/bin/agent"));
        let mut chat = input(&agent, &layout);
        chat.folders = vec![layout.home.join("src/shop")];
        chat.kubeconfigs = vec![
            layout.home.join("src/shop/kubeconfig"),
            layout.home.join(".kube/config"),
        ];
        let spec = build_spec(chat);
        assert_eq!(spec.hidden_files, [layout.home.join("src/shop/kubeconfig")]);
    }

    #[test]
    fn a_folder_that_holds_the_home_folder_is_left_out() {
        let layout = layout();
        std::fs::create_dir_all(layout.root.join("shop")).unwrap();
        let agent = test_agent(&layout.root.join("agent/bin/agent"));
        let mut chat = input(&agent, &layout);
        chat.folders = vec![
            layout.root.clone(),
            layout.home.clone(),
            layout.root.join("shop"),
        ];
        let spec = build_spec(chat);
        assert_eq!(
            spec.read_only,
            [
                layout.root.join("agent"),
                layout.root.join("app"),
                layout.root.join("shop"),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_program_runs_from_its_real_path() {
        let layout = layout();
        let real = layout.root.join("opt/agent/agent");
        write(&real, "");
        std::fs::create_dir_all(layout.home.join(".local/bin")).unwrap();
        std::os::unix::fs::symlink(&real, layout.home.join(".local/bin/agent")).unwrap();
        let agent = test_agent(&layout.home.join(".local/bin/agent"));
        assert_eq!(build_spec(input(&agent, &layout)).program, real);
    }

    #[test]
    fn the_debug_form_names_the_variables_without_their_values() {
        let layout = layout();
        let agent = test_agent(&layout.root.join("agent/bin/agent"));
        let mut chat = input(&agent, &layout);
        chat.env = vec![("ANTHROPIC_API_KEY".to_owned(), "sk-ant-secret".to_owned())];
        let shown = format!("{:?}", build_spec(chat));
        assert!(shown.contains("ANTHROPIC_API_KEY"), "{shown}");
        assert!(!shown.contains("sk-ant-secret"), "{shown}");
    }

    #[test]
    fn the_linux_sandbox_ports_are_fixed() {
        assert_eq!(
            ChatPorts::LINUX_SANDBOX,
            ChatPorts {
                proxy: 3128,
                mcp: 3129
            }
        );
    }
}
