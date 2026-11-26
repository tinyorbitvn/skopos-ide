//! The fake agent's script: what `initialize` and `session/new` answer, and what each
//! `session/prompt` plays, read from a JSON file.

use std::ffi::OsString;
use std::path::PathBuf;

use agent_client_protocol::v1::schema::SessionConfigOption;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The variable that names the script file when `--script` is not given.
pub const SCRIPT_VAR: &str = "SKOPOS_FAKEAGENT_SCRIPT";
/// The variable that names the request log when `--log` is not given.
pub const LOG_VAR: &str = "SKOPOS_FAKEAGENT_LOG";
/// The variable that names the env file when `--env-file` is not given.
pub const ENV_FILE_VAR: &str = "SKOPOS_FAKEAGENT_ENV_FILE";

/// A whole script. Every field may be left out: `{}` signs in, cannot load sessions and
/// ends every turn at once with `end_turn`.
#[derive(Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Script {
    pub auth: Auth,
    /// The `loadSession` capability that `initialize` reports.
    pub load_session: bool,
    /// The session config options `session/new` and `session/load` answer with;
    /// `session/set_config_option` changes them. Empty: the answers carry none.
    pub config_options: Vec<SessionConfigOption>,
    /// When set, `session/set_config_option` fails with this message.
    pub refuse_config_option: Option<String>,
    /// One turn per `session/prompt`, in order; a prompt past the last one ends at once.
    pub turns: Vec<Turn>,
}

/// Whether `session/new` succeeds.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Auth {
    #[default]
    #[serde(rename = "ok")]
    SignedIn,
    /// `session/new` fails with ACP's authentication-required error.
    #[serde(rename = "required")]
    Required,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Turn {
    pub steps: Vec<Step>,
}

/// One step of a turn, written as a one-key object such as `{ "say": "text" }`, or as
/// `"signIn"`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    /// A `plan` update with these entries.
    Plan(Vec<PlanItem>),
    /// An `agent_message_chunk` with this text.
    Say(String),
    /// Calls a tool of the `skopos` MCP server and says `tool:<name>:<first line>`.
    Tool(ToolStep),
    /// A `tool_call` of the agent's own, with a permission request when asked.
    OwnTool(OwnToolStep),
    /// A `tool_call` of the agent's own that asks for permission, then runs or not.
    Permission(PermissionStep),
    /// Several `permission` steps whose requests wait at the same time.
    Permissions(Vec<PermissionStep>),
    /// Exits the process with this code in the middle of the turn.
    Exit(i32),
    /// Waits this many milliseconds; `session/cancel` ends the wait.
    Sleep(u64),
    /// Ends the turn with this stop reason.
    Stop(StopKind),
    /// Fails the prompt with ACP's authentication-required error.
    SignIn,
    /// Sends a `config_option_update` with these options and makes them the agent's.
    ConfigOptions(Vec<SessionConfigOption>),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanItem {
    pub content: String,
    pub status: PlanItemStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolStep {
    pub name: String,
    #[serde(default)]
    pub args: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnToolStep {
    pub title: String,
    /// Asks `session/request_permission` with all four option kinds before it runs.
    #[serde(default)]
    pub permission: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionStep {
    pub title: String,
    /// The ACP tool kind, such as `execute`; `other` when left out.
    #[serde(default)]
    pub kind: Option<String>,
    /// The tool call's `rawInput.command`.
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopKind {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
}

impl Script {
    pub fn parse(text: &str) -> Result<Script, String> {
        serde_json::from_str(text).map_err(|error| error.to_string())
    }
}

/// Where the script, the log and the env file are.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub script: Option<PathBuf>,
    pub log: Option<PathBuf>,
    /// Written at start: `pid=<id>`, then one `NAME=value` line per environment variable.
    pub env_file: Option<PathBuf>,
}

impl Options {
    /// Reads `SKOPOS_FAKEAGENT_SCRIPT`, `SKOPOS_FAKEAGENT_LOG` and `SKOPOS_FAKEAGENT_ENV_FILE`
    /// through `var`, then `--script <file>`, `--log <file>` and `--env-file <file>` from
    /// `args` (the arguments after the program), which win, so a test need not depend on the
    /// agent's environment.
    pub fn from_args(
        mut args: impl Iterator<Item = String>,
        var: impl Fn(&str) -> Option<OsString>,
    ) -> Result<Options, String> {
        let mut options = Options {
            script: var(SCRIPT_VAR).map(PathBuf::from),
            log: var(LOG_VAR).map(PathBuf::from),
            env_file: var(ENV_FILE_VAR).map(PathBuf::from),
        };
        while let Some(arg) = args.next() {
            let slot = match arg.as_str() {
                "--script" => &mut options.script,
                "--log" => &mut options.log,
                "--env-file" => &mut options.env_file,
                _ => return Err(format!("unknown argument: {arg}")),
            };
            let file = args.next().ok_or_else(|| format!("{arg} needs a file"))?;
            *slot = Some(PathBuf::from(file));
        }
        Ok(options)
    }

    /// The script, or the empty script when none is named. An error names the file.
    pub fn load_script(&self) -> Result<Script, String> {
        let Some(path) = &self.script else {
            return Ok(Script::default());
        };
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        Script::parse(&text).map_err(|error| format!("{}: {error}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    const PLAN_EXAMPLE: &str = r#"{ "auth": "ok",
      "loadSession": true,
      "turns": [ { "steps": [
        { "plan": [ { "content": "Find the api Pods", "status": "completed" } ] },
        { "say": "text chunk" },
        { "tool": { "name": "list_objects", "args": { "kind": "Pod", "namespace": "payments" } } },
        { "ownTool": { "title": "Run ls", "permission": true } },
        { "permission": { "title": "Run ls", "kind": "execute", "command": "ls -la" } },
        { "permissions": [ { "title": "Read a" }, { "title": "Run b", "command": "b" } ] },
        { "exit": 3 },
        { "stop": "end_turn" }
      ] } ] }"#;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    #[test]
    fn config_options_parse_from_the_wire_shape() {
        let script = Script::parse(
            r#"{
                "configOptions": [{
                    "id": "model", "name": "Model", "category": "model", "type": "select",
                    "currentValue": "a", "options": [{ "value": "a", "name": "A" }]
                }],
                "refuseConfigOption": "Model is locked",
                "turns": [{ "steps": [{ "configOptions": [] }] }]
            }"#,
        )
        .unwrap();
        assert_eq!(script.config_options.len(), 1);
        assert_eq!(&*script.config_options[0].id.0, "model");
        assert_eq!(
            script.refuse_config_option.as_deref(),
            Some("Model is locked")
        );
        assert_eq!(script.turns[0].steps, vec![Step::ConfigOptions(Vec::new())]);
    }

    #[test]
    fn the_plans_example_script_parses() {
        let script = Script::parse(PLAN_EXAMPLE).unwrap();
        let args = json!({ "kind": "Pod", "namespace": "payments" });
        assert_eq!(
            script,
            Script {
                auth: Auth::SignedIn,
                load_session: true,
                config_options: Vec::new(),
                refuse_config_option: None,
                turns: vec![Turn {
                    steps: vec![
                        Step::Plan(vec![PlanItem {
                            content: "Find the api Pods".to_owned(),
                            status: PlanItemStatus::Completed,
                        }]),
                        Step::Say("text chunk".to_owned()),
                        Step::Tool(ToolStep {
                            name: "list_objects".to_owned(),
                            args: args.as_object().unwrap().clone(),
                        }),
                        Step::OwnTool(OwnToolStep {
                            title: "Run ls".to_owned(),
                            permission: true,
                        }),
                        Step::Permission(PermissionStep {
                            title: "Run ls".to_owned(),
                            kind: Some("execute".to_owned()),
                            command: Some("ls -la".to_owned()),
                        }),
                        Step::Permissions(vec![
                            PermissionStep {
                                title: "Read a".to_owned(),
                                kind: None,
                                command: None,
                            },
                            PermissionStep {
                                title: "Run b".to_owned(),
                                kind: None,
                                command: Some("b".to_owned()),
                            },
                        ]),
                        Step::Exit(3),
                        Step::Stop(StopKind::EndTurn),
                    ],
                }],
            }
        );
    }

    #[test]
    fn an_empty_script_signs_in_cannot_load_and_has_no_turns() {
        let script = Script::parse("{}").unwrap();
        assert_eq!(script, Script::default());
        assert_eq!(script.auth, Auth::SignedIn);
        assert!(!script.load_session);
        assert!(script.turns.is_empty());

        let script = Script::parse(r#"{ "auth": "required", "turns": [ {} ] }"#).unwrap();
        assert_eq!(script.auth, Auth::Required);
        assert_eq!(script.turns, vec![Turn::default()]);
    }

    #[test]
    fn each_stop_reason_plan_status_and_the_sleep_step_have_their_names() {
        let script = Script::parse(
            r#"{ "turns": [ { "steps": [
                { "stop": "end_turn" }, { "stop": "max_tokens" },
                { "stop": "max_turn_requests" }, { "stop": "refusal" },
                { "plan": [
                    { "content": "a", "status": "pending" },
                    { "content": "b", "status": "in_progress" },
                    { "content": "c", "status": "completed" } ] },
                { "sleep": 250 },
                { "tool": { "name": "list_kinds" } },
                { "ownTool": { "title": "Edit a.txt" } },
                "signIn"
            ] } ] }"#,
        )
        .unwrap();
        let item = |content: &str, status| PlanItem {
            content: content.to_owned(),
            status,
        };
        assert_eq!(
            script.turns[0].steps,
            vec![
                Step::Stop(StopKind::EndTurn),
                Step::Stop(StopKind::MaxTokens),
                Step::Stop(StopKind::MaxTurnRequests),
                Step::Stop(StopKind::Refusal),
                Step::Plan(vec![
                    item("a", PlanItemStatus::Pending),
                    item("b", PlanItemStatus::InProgress),
                    item("c", PlanItemStatus::Completed),
                ]),
                Step::Sleep(250),
                Step::Tool(ToolStep {
                    name: "list_kinds".to_owned(),
                    args: serde_json::Map::new(),
                }),
                Step::OwnTool(OwnToolStep {
                    title: "Edit a.txt".to_owned(),
                    permission: false,
                }),
                Step::SignIn,
            ]
        );
    }

    #[test]
    fn an_unknown_step_or_field_is_refused() {
        for text in [
            r#"{ "turns": [ { "steps": [ { "dance": 1 } ] } ] }"#,
            r#"{ "auth": "ok", "colour": "red" }"#,
            r#"{ "auth": "maybe" }"#,
            r#"{ "turns": [ { "steps": [ { "ownTool": { "title": "x", "approve": true } } ] } ] }"#,
            r#"{ "turns": [ { "steps": [ { "stop": "tired" } ] } ] }"#,
            r#"{ "turns": [ { "steps": [], "pause": 1 } ] }"#,
        ] {
            assert!(Script::parse(text).is_err(), "{text}");
        }
    }

    #[test]
    fn arguments_beat_the_environment() {
        let env = vars(&[
            (SCRIPT_VAR, "/env/script.json"),
            (LOG_VAR, "/env/agent.log"),
            (ENV_FILE_VAR, "/env/agent.env"),
        ]);
        let args = words(&[
            "--script",
            "/arg/script.json",
            "--env-file",
            "/arg/agent.env",
        ]);
        let options = Options::from_args(args.into_iter(), env).unwrap();
        assert_eq!(
            options,
            Options {
                script: Some(PathBuf::from("/arg/script.json")),
                log: Some(PathBuf::from("/env/agent.log")),
                env_file: Some(PathBuf::from("/arg/agent.env")),
            }
        );
    }

    #[test]
    fn the_environment_names_the_script_and_the_log_without_arguments() {
        let env = vars(&[
            (SCRIPT_VAR, "/env/script.json"),
            (LOG_VAR, "/env/agent.log"),
            (ENV_FILE_VAR, "/env/agent.env"),
        ]);
        let options = Options::from_args(Vec::new().into_iter(), env).unwrap();
        assert_eq!(options.script, Some(PathBuf::from("/env/script.json")));
        assert_eq!(options.log, Some(PathBuf::from("/env/agent.log")));
        assert_eq!(options.env_file, Some(PathBuf::from("/env/agent.env")));

        let options = Options::from_args(Vec::new().into_iter(), vars(&[])).unwrap();
        assert_eq!(options, Options::default());
        assert_eq!(options.load_script().unwrap(), Script::default());
    }

    #[test]
    fn an_unknown_argument_or_a_missing_file_name_is_an_error() {
        assert_eq!(
            Options::from_args(words(&["--verbose"]).into_iter(), vars(&[])),
            Err("unknown argument: --verbose".to_owned())
        );
        assert_eq!(
            Options::from_args(words(&["--log"]).into_iter(), vars(&[])),
            Err("--log needs a file".to_owned())
        );
        assert_eq!(
            Options::from_args(words(&["--env-file"]).into_iter(), vars(&[])),
            Err("--env-file needs a file".to_owned())
        );
    }

    #[test]
    fn a_script_file_is_read_and_a_missing_or_bad_one_is_an_error_naming_it() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("script.json");
        std::fs::write(&good, r#"{ "loadSession": true }"#).unwrap();
        let options = Options {
            script: Some(good),
            log: None,
            env_file: None,
        };
        assert!(options.load_script().unwrap().load_session);

        let missing = dir.path().join("missing.json");
        let options = Options {
            script: Some(missing.clone()),
            log: None,
            env_file: None,
        };
        let error = options.load_script().unwrap_err();
        assert!(
            error.starts_with(&format!("{}: ", missing.display())),
            "{error}"
        );

        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{ not json").unwrap();
        let options = Options {
            script: Some(bad.clone()),
            log: None,
            env_file: None,
        };
        let error = options.load_script().unwrap_err();
        assert!(
            error.starts_with(&format!("{}: ", bad.display())),
            "{error}"
        );
    }
}
