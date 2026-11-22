//! The fake agent's side of the `skopos` MCP server: it starts the stdio server the client
//! named in `mcpServers` and calls its tools as an `rmcp` client.

use std::process::Stdio;
use std::time::Duration;

use agent_client_protocol::v1::schema::McpServerStdio;
use rmcp::model::{CallToolRequestParams, JsonObject};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceExt};
use tokio::process::{Child, Command};

/// How long the server may take to answer MCP's `initialize`.
const CONNECT_LIMIT: Duration = Duration::from_secs(10);

pub struct McpClient {
    service: RunningService<RoleClient, ()>,
    // Killed when the client goes.
    _child: Child,
}

impl McpClient {
    /// Starts `server` with its arguments and environment and connects to it over its stdin
    /// and stdout. Its stderr is the fake agent's, so its messages reach the core's log.
    pub async fn connect(server: &McpServerStdio) -> Result<McpClient, String> {
        let mut child = Command::new(&server.command)
            .args(&server.args)
            .envs(
                server
                    .env
                    .iter()
                    .map(|variable| (&variable.name, &variable.value)),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("{}: {error}", server.command.display()))?;
        let stdout = child.stdout.take().ok_or("the MCP server has no stdout")?;
        let stdin = child.stdin.take().ok_or("the MCP server has no stdin")?;
        let service = tokio::time::timeout(CONNECT_LIMIT, ().serve((stdout, stdin)))
            .await
            .map_err(|_| "the MCP server did not answer".to_owned())?
            .map_err(|error| error.to_string())?;
        Ok(McpClient {
            service,
            _child: child,
        })
    }

    /// Calls tool `name`: `Ok` with its text blocks joined by newlines, `Err` with them when
    /// the tool reports an error, or with the call's own error.
    pub async fn call(&self, name: &str, args: JsonObject) -> Result<String, String> {
        let request = CallToolRequestParams::new(name.to_owned()).with_arguments(args);
        let result = self
            .service
            .call_tool(request)
            .await
            .map_err(|error| error.to_string())?;
        let text: Vec<&str> = result
            .content
            .iter()
            .filter_map(|block| block.as_text())
            .map(|text| text.text.as_str())
            .collect();
        let text = text.join("\n");
        if result.is_error == Some(true) {
            Err(text)
        } else {
            Ok(text)
        }
    }
}
