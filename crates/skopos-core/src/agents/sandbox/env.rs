//! The agent's environment (spec §4.6): the listed variables, the proxy with the chat's token,
//! the agent's own pairs and its own provider keys. Nothing else the app has, such as
//! `KUBECONFIG`, cloud, SSH or Docker variables, reaches the agent (spec §6.2).

use std::fmt::Display;
use std::path::Path;

use super::paths::real_path;
use crate::agents::registry::AgentSpec;

/// The locale categories passed on when the app has them: spec §4.6's `LC_*`.
pub const LC_VARS: [&str; 13] = [
    "LC_ALL",
    "LC_ADDRESS",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_IDENTIFICATION",
    "LC_MEASUREMENT",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NAME",
    "LC_NUMERIC",
    "LC_PAPER",
    "LC_TELEPHONE",
    "LC_TIME",
];
/// What the agent reaches without the proxy: its own loopback, where its MCP entry connects.
pub const NO_PROXY: &str = "localhost,127.0.0.1,::1";

/// The agent's whole environment, in this order: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, the
/// `LC_*` variables, `TZ`, `TERM=dumb`, `TMPDIR`, the proxy variables, `NODE_USE_ENV_PROXY=1`,
/// the agent's own pairs, then each of its provider keys. `get` reads the app's environment;
/// what it does not return is left out, and nothing else of it is read.
pub fn agent_env(
    get: &dyn Fn(&str) -> Option<String>,
    agent: &AgentSpec,
    proxy_url: &str,
    tmp_dir: &Path,
    home: &Path,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    let pass = |env: &mut Vec<(String, String)>, name: &str| {
        if let Some(value) = get(name) {
            env.push((name.to_owned(), value));
        }
    };
    pass(&mut env, "PATH");
    env.push(pair("HOME", home.display()));
    for name in ["USER", "LOGNAME", "LANG"] {
        pass(&mut env, name);
    }
    for name in LC_VARS {
        pass(&mut env, name);
    }
    pass(&mut env, "TZ");
    env.push(pair("TERM", "dumb"));
    env.push(pair("TMPDIR", tmp_dir.display()));
    for name in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] {
        env.push(pair(name, proxy_url));
    }
    for name in ["NO_PROXY", "no_proxy"] {
        env.push(pair(name, NO_PROXY));
    }
    env.push(pair("NODE_USE_ENV_PROXY", "1"));
    for (name, value) in &agent.env {
        env.push((name.clone(), agent_value(value)));
    }
    for name in &agent.key_vars {
        pass(&mut env, name.as_str());
    }
    env
}

/// The proxy URL the agent's proxy variables hold: `http://skopos:<token>@127.0.0.1:<port>`.
pub fn proxy_url(token: &str, port: u16) -> String {
    format!("http://skopos:{token}@127.0.0.1:{port}")
}

fn pair(name: &str, value: impl Display) -> (String, String) {
    (name.to_owned(), value.to_string())
}

/// A path among the agent's pairs, such as the CLI its adapter starts, is given as its real
/// path: the sandbox shows installs at their real paths, and a link under the home folder would
/// lead nowhere inside it.
fn agent_value(value: &str) -> String {
    if value.starts_with('/') {
        real_path(Path::new(value)).display().to_string()
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use super::*;
    use crate::agents::registry::AgentSpec;
    use crate::agents::sandbox::test_agent;

    /// What a person's desktop session may hold, the agents' own keys among it.
    fn app_env() -> HashMap<&'static str, &'static str> {
        [
            ("PATH", "/usr/bin:/bin"),
            ("USER", "me"),
            ("LOGNAME", "me"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "C.UTF-8"),
            ("LC_CTYPE", "C.UTF-8"),
            ("TZ", "Europe/Berlin"),
            ("TERM", "xterm-256color"),
            ("TMPDIR", "/var/tmp/me"),
            ("HOME", "/home/elsewhere"),
            ("HTTPS_PROXY", "http://corp-proxy:8080"),
            ("KUBECONFIG", "/etc/skopos-test/config"),
            ("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE"),
            ("AWS_PROFILE", "prod"),
            ("GOOGLE_APPLICATION_CREDENTIALS", "/home/me/key.json"),
            ("AZURE_CONFIG_DIR", "/home/me/.azure"),
            ("SSH_AUTH_SOCK", "/run/user/1000/ssh-agent"),
            ("DOCKER_HOST", "unix:///run/docker.sock"),
            ("DISPLAY", ":0"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("ANTHROPIC_API_KEY", "sk-ant-example"),
            ("OPENAI_API_KEY", "sk-openai-example"),
            ("GEMINI_API_KEY", "gemini-example"),
        ]
        .into_iter()
        .collect()
    }

    fn claude() -> AgentSpec {
        let mut agent = test_agent(Path::new("/opt/skopos-test/bin/claude-agent-acp"));
        agent.env = vec![
            (
                "CLAUDE_CODE_EXECUTABLE".to_owned(),
                "/opt/skopos-test/bin/claude".to_owned(),
            ),
            (
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_owned(),
                "1".to_owned(),
            ),
        ];
        agent.key_vars = vec![
            "ANTHROPIC_API_KEY".to_owned(),
            "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
        ];
        agent
    }

    fn codex() -> AgentSpec {
        let mut agent = test_agent(Path::new("/opt/skopos-test/bin/codex-acp"));
        agent.key_vars = vec!["OPENAI_API_KEY".to_owned(), "CODEX_API_KEY".to_owned()];
        agent
    }

    fn env_of(agent: &AgentSpec) -> Vec<(String, String)> {
        let app = app_env();
        let get = move |name: &str| app.get(name).map(|value| value.to_string());
        agent_env(
            &get,
            agent,
            &proxy_url("t0k3n", 3128),
            Path::new("/data/agents/run/0a1b2c3d/tmp"),
            Path::new("/home/me"),
        )
    }

    fn names(env: &[(String, String)]) -> Vec<&str> {
        env.iter().map(|(name, _)| name.as_str()).collect()
    }

    fn value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
        env.iter()
            .find(|(found, _)| found == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn the_environment_is_exactly_the_listed_variables_in_order() {
        let env = env_of(&claude());
        assert_eq!(
            names(&env),
            [
                "PATH",
                "HOME",
                "USER",
                "LOGNAME",
                "LANG",
                "LC_ALL",
                "LC_CTYPE",
                "TZ",
                "TERM",
                "TMPDIR",
                "HTTPS_PROXY",
                "HTTP_PROXY",
                "https_proxy",
                "http_proxy",
                "NO_PROXY",
                "no_proxy",
                "NODE_USE_ENV_PROXY",
                "CLAUDE_CODE_EXECUTABLE",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
                "ANTHROPIC_API_KEY",
            ]
        );
        assert_eq!(value(&env, "HOME"), Some("/home/me"));
        assert_eq!(value(&env, "TERM"), Some("dumb"));
        assert_eq!(value(&env, "TMPDIR"), Some("/data/agents/run/0a1b2c3d/tmp"));
        for name in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] {
            assert_eq!(
                value(&env, name),
                Some("http://skopos:t0k3n@127.0.0.1:3128"),
                "{name}"
            );
        }
        for name in ["NO_PROXY", "no_proxy"] {
            assert_eq!(value(&env, name), Some("localhost,127.0.0.1,::1"), "{name}");
        }
        assert_eq!(value(&env, "NODE_USE_ENV_PROXY"), Some("1"));
        assert_eq!(
            value(&env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
            Some("1")
        );
    }

    #[test]
    fn kubeconfig_cloud_ssh_and_docker_variables_never_reach_the_agent() {
        let env = env_of(&claude());
        for name in [
            "KUBECONFIG",
            "AWS_ACCESS_KEY_ID",
            "AWS_PROFILE",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AZURE_CONFIG_DIR",
            "SSH_AUTH_SOCK",
            "DOCKER_HOST",
            "DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ] {
            assert_eq!(value(&env, name), None, "{name}");
        }
    }

    #[test]
    fn a_provider_key_reaches_only_its_own_agent() {
        let claude = env_of(&claude());
        assert_eq!(value(&claude, "ANTHROPIC_API_KEY"), Some("sk-ant-example"));
        assert_eq!(value(&claude, "OPENAI_API_KEY"), None);
        assert_eq!(value(&claude, "GEMINI_API_KEY"), None);
        // Unset in the app, so left out.
        assert_eq!(value(&claude, "CLAUDE_CODE_OAUTH_TOKEN"), None);
        let codex = env_of(&codex());
        assert_eq!(value(&codex, "OPENAI_API_KEY"), Some("sk-openai-example"));
        assert_eq!(value(&codex, "ANTHROPIC_API_KEY"), None);
        assert_eq!(value(&codex, "CODEX_API_KEY"), None);
    }

    #[test]
    fn the_proxy_url_carries_the_chat_token() {
        assert_eq!(
            proxy_url("0123abcd", 50123),
            "http://skopos:0123abcd@127.0.0.1:50123"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_path_in_the_agents_variables_is_given_as_its_real_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::agents::sandbox::paths::real_path(dir.path());
        let real = root.join("claude/versions/2.1.0");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "").unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::os::unix::fs::symlink(&real, root.join("bin/claude")).unwrap();
        let mut agent = claude();
        agent.env[0].1 = root.join("bin/claude").display().to_string();
        let env = env_of(&agent);
        assert_eq!(
            value(&env, "CLAUDE_CODE_EXECUTABLE"),
            Some(real.display().to_string().as_str())
        );
        assert_eq!(
            value(&env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
            Some("1")
        );
    }
}
