//! The program a kubeconfig runs for credentials, and the fingerprint a consent is tied to.

use kube::config::{AuthProviderConfig, ExecConfig, Kubeconfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

/// Changed when the encoding changes, so that every stored consent asks again.
const FINGERPRINT_VERSION: &[u8] = b"skopos-exec-consent-1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ExecCommandKind {
    /// The user's `exec` section.
    Exec,
    /// The `cmd-path` of a `gcp` `auth-provider`.
    GcpAuthProvider,
}

/// What `kube` would run for the one user of an extracted kubeconfig.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecCommand {
    pub(crate) kind: ExecCommandKind,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) server: String,
    /// Hex SHA-256 of everything that decides what runs and where its credentials go.
    pub(crate) fingerprint: String,
}

/// One cluster's consent. It holds a digest, never an argument or a value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecConsent {
    pub(crate) fingerprint: String,
}

/// What a blocked connect refused to run, without its arguments or environment values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExecRequest {
    /// Names this request to the calls that act on it.
    pub request_id: u32,
    pub kind: ExecCommandKind,
    pub command: String,
    pub arg_count: u32,
    pub env_names: Vec<String>,
    pub server: String,
    pub source_path: String,
    pub context_name: String,
    /// The user allowed something else for this cluster before.
    pub changed: bool,
}

/// One section's program, before the two are told apart.
struct Invocation {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    /// Settings that change the run without being an argument or a variable.
    extra: Vec<String>,
}

fn exec_invocation(exec: &ExecConfig) -> Option<Invocation> {
    let command = exec.command.as_deref().filter(|c| !c.trim().is_empty())?;
    // `kube` passes only the entries that have both a name and a value.
    let env = exec
        .env
        .iter()
        .flatten()
        .filter_map(|var| Some((var.get("name")?.clone(), var.get("value")?.clone())))
        .collect();
    let interactive = serde_json::to_string(&exec.interactive_mode).unwrap_or_default();
    Some(Invocation {
        command: command.to_owned(),
        args: exec.args.clone().unwrap_or_default(),
        env,
        extra: vec![interactive, exec.provide_cluster_info.to_string()],
    })
}

fn gcp_invocation(provider: &AuthProviderConfig) -> Option<Invocation> {
    if provider.name != "gcp" {
        return None;
    }
    let command = provider
        .config
        .get("cmd-path")
        .filter(|c| !c.trim().is_empty())?;
    let setting = |key: &str| provider.config.get(key).cloned().unwrap_or_default();
    let raw_args = setting("cmd-args");
    // `kube` splits the arguments on spaces.
    let args = raw_args
        .split(' ')
        .filter(|arg| !arg.is_empty())
        .map(str::to_owned)
        .collect();
    Some(Invocation {
        command: command.clone(),
        args,
        env: Vec::new(),
        extra: vec![raw_args, setting("cmd-drop-env")],
    })
}

/// Length-prefixed, so that two different inputs cannot encode alike.
fn put(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn put_all(hasher: &mut Sha256, items: &[&str]) {
    hasher.update(u64::try_from(items.len()).unwrap_or(u64::MAX).to_be_bytes());
    for item in items {
        put(hasher, item.as_bytes());
    }
}

fn put_invocation(hasher: &mut Sha256, invocation: Option<&Invocation>) {
    let Some(invocation) = invocation else {
        hasher.update([0u8]);
        return;
    };
    hasher.update([1u8]);
    put(hasher, invocation.command.as_bytes());
    let args: Vec<&str> = invocation.args.iter().map(String::as_str).collect();
    put_all(hasher, &args);
    let env: Vec<&str> = invocation
        .env
        .iter()
        .flat_map(|(name, value)| [name.as_str(), value.as_str()])
        .collect();
    put_all(hasher, &env);
    let extra: Vec<&str> = invocation.extra.iter().map(String::as_str).collect();
    put_all(hasher, &extra);
}

/// The program `kube` would run for the kubeconfig's user, or `None` when it runs none.
pub(crate) fn exec_command(kubeconfig: &Kubeconfig) -> Option<ExecCommand> {
    let user = kubeconfig
        .auth_infos
        .iter()
        .find_map(|named| named.auth_info.as_ref())?;
    let gcp = user.auth_provider.as_ref().and_then(gcp_invocation);
    let exec = user.exec.as_ref().and_then(exec_invocation);
    let server = kubeconfig
        .clusters
        .iter()
        .find_map(|named| named.cluster.as_ref())
        .and_then(|cluster| cluster.server.clone())
        .unwrap_or_default();

    let mut hasher = Sha256::new();
    put(&mut hasher, FINGERPRINT_VERSION);
    put(&mut hasher, server.as_bytes());
    // Both are encoded: a change to either must ask again, whichever one `kube` prefers.
    put_invocation(&mut hasher, gcp.as_ref());
    put_invocation(&mut hasher, exec.as_ref());
    let fingerprint = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    // `kube` 5.0 uses an auth provider before `exec`, so that is what runs with both.
    let (kind, shown) = match (gcp, exec) {
        (Some(gcp), _) => (ExecCommandKind::GcpAuthProvider, gcp),
        (None, Some(exec)) => (ExecCommandKind::Exec, exec),
        (None, None) => return None,
    };
    Some(ExecCommand {
        kind,
        command: shown.command,
        args: shown.args,
        env: shown.env,
        server,
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXEC: &str = "{ exec: { apiVersion: client.authentication.k8s.io/v1, command: aws, \
        args: [eks, get-token, --cluster-name, prod], \
        env: [{ name: AWS_PROFILE, value: work }], interactiveMode: Never } }";
    const GCP: &str = "{ auth-provider: { name: gcp, config: { cmd-path: /usr/bin/gcloud, \
        cmd-args: \"config config-helper --format=json\", access-token: cached } } }";

    fn kubeconfig(server: &str, user: &str) -> Kubeconfig {
        let text = format!(
            "apiVersion: v1\nkind: Config\n\
             clusters:\n- {{ name: c1, cluster: {{ server: \"{server}\" }} }}\n\
             users:\n- name: u1\n  user: {user}\n\
             contexts:\n- {{ name: one, context: {{ cluster: c1, user: u1 }} }}\n\
             current-context: one\n"
        );
        serde_yaml_ng::from_str(&text).unwrap()
    }

    fn fingerprint(server: &str, user: &str) -> String {
        exec_command(&kubeconfig(server, user)).unwrap().fingerprint
    }

    #[test]
    fn a_static_token_runs_nothing() {
        assert_eq!(exec_command(&kubeconfig("https://x", "{ token: t }")), None);
    }

    #[test]
    fn an_exec_section_is_what_runs() {
        let command = exec_command(&kubeconfig("https://x", EXEC)).unwrap();

        assert_eq!(command.kind, ExecCommandKind::Exec);
        assert_eq!(command.command, "aws");
        assert_eq!(command.args, ["eks", "get-token", "--cluster-name", "prod"]);
        assert_eq!(command.env, [("AWS_PROFILE".to_owned(), "work".to_owned())]);
        assert_eq!(command.server, "https://x");
        assert_eq!(command.fingerprint.len(), 64);
        assert!(command.fingerprint.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn the_fingerprint_follows_everything_that_decides_the_run() {
        let base = fingerprint("https://x", EXEC);
        let changed = [
            ("the command", EXEC.replace("command: aws", "command: aws2")),
            ("an argument", EXEC.replace("prod", "staging")),
            (
                "the argument order",
                EXEC.replace("[eks, get-token,", "[get-token, eks,"),
            ),
            ("an environment value", EXEC.replace("work", "home")),
            (
                "an environment name",
                EXEC.replace("AWS_PROFILE", "AWS_REGION"),
            ),
            (
                "the interactive mode",
                EXEC.replace("interactiveMode: Never", "interactiveMode: Always"),
            ),
            (
                "the cluster info setting",
                EXEC.replace(
                    "interactiveMode: Never",
                    "interactiveMode: Never, provideClusterInfo: true",
                ),
            ),
        ];
        for (what, user) in changed {
            assert_ne!(fingerprint("https://x", &user), base, "{what}");
        }
        assert_ne!(fingerprint("https://y", EXEC), base, "the server");
        assert_eq!(fingerprint("https://x", EXEC), base, "the same input");
    }

    #[test]
    fn the_fingerprint_ignores_what_does_not_change_the_run() {
        let hinted = EXEC.replace(
            "command: aws",
            "command: aws, installHint: \"install the AWS CLI\"",
        );

        assert_eq!(
            fingerprint("https://x", &hinted),
            fingerprint("https://x", EXEC)
        );
        // A refreshed token cache is not a change to what runs.
        let refreshed = GCP.replace("access-token: cached", "access-token: refreshed");
        assert_eq!(
            fingerprint("https://x", &refreshed),
            fingerprint("https://x", GCP)
        );
    }

    #[test]
    fn the_same_command_in_the_other_section_is_another_fingerprint() {
        let exec =
            "{ exec: { apiVersion: client.authentication.k8s.io/v1, command: /usr/bin/gcloud } }";
        let provider = "{ auth-provider: { name: gcp, config: { cmd-path: /usr/bin/gcloud } } }";

        assert_ne!(
            fingerprint("https://x", exec),
            fingerprint("https://x", provider)
        );
    }

    #[test]
    fn two_argument_lists_cannot_encode_alike() {
        let split = |args: &str| {
            format!("{{ exec: {{ apiVersion: client.authentication.k8s.io/v1, command: p, args: {args} }} }}")
        };

        assert_ne!(
            fingerprint("https://x", &split("[ab, c]")),
            fingerprint("https://x", &split("[a, bc]"))
        );
    }

    #[test]
    fn an_environment_entry_without_a_value_is_left_out() {
        let user = EXEC.replace(
            "{ name: AWS_PROFILE, value: work }",
            "{ name: AWS_PROFILE, value: work }, { name: HALF }",
        );

        let command = exec_command(&kubeconfig("https://x", &user)).unwrap();

        assert_eq!(command.env, [("AWS_PROFILE".to_owned(), "work".to_owned())]);
    }

    #[test]
    fn an_exec_section_without_a_command_runs_nothing() {
        let user = "{ exec: { apiVersion: client.authentication.k8s.io/v1, args: [a] } }";

        assert_eq!(exec_command(&kubeconfig("https://x", user)), None);
    }

    #[test]
    fn a_gcp_auth_provider_command_is_what_runs() {
        let command = exec_command(&kubeconfig("https://x", GCP)).unwrap();

        assert_eq!(command.kind, ExecCommandKind::GcpAuthProvider);
        assert_eq!(command.command, "/usr/bin/gcloud");
        assert_eq!(command.args, ["config", "config-helper", "--format=json"]);
        assert!(command.env.is_empty());
        assert_ne!(
            fingerprint(
                "https://x",
                &GCP.replace("config-helper", "print-access-token")
            ),
            command.fingerprint
        );
    }

    #[test]
    fn an_auth_provider_without_a_command_runs_nothing() {
        let oidc = "{ auth-provider: { name: oidc, config: { id-token: t } } }";
        let cached = "{ auth-provider: { name: gcp, config: { access-token: t } } }";

        assert_eq!(exec_command(&kubeconfig("https://x", oidc)), None);
        assert_eq!(exec_command(&kubeconfig("https://x", cached)), None);
    }

    #[test]
    fn an_auth_provider_wins_over_exec_and_both_are_fingerprinted() {
        let both = "{ auth-provider: { name: gcp, config: { cmd-path: /usr/bin/gcloud } }, \
            exec: { apiVersion: client.authentication.k8s.io/v1, command: aws, args: [one] } }";

        let command = exec_command(&kubeconfig("https://x", both)).unwrap();

        // `kube` 5.0 uses an auth provider before `exec`.
        assert_eq!(command.kind, ExecCommandKind::GcpAuthProvider);
        assert_eq!(command.command, "/usr/bin/gcloud");
        assert_ne!(
            fingerprint("https://x", &both.replace("[one]", "[two]")),
            command.fingerprint,
            "a change to the section that does not run today asks again too"
        );
    }

    #[test]
    fn the_kind_serializes_for_the_ui() {
        assert_eq!(
            serde_json::to_value(ExecCommandKind::GcpAuthProvider).unwrap(),
            "gcpAuthProvider"
        );
    }
}
