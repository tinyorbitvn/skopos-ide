//! The `skopos` MCP server of one chat (spec §4.4), served on a stream its endpoint
//! accepted. `tool_list` and `dispatch` are where the change tools join the reads.

use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};

use super::tools::{call_read, read_tools};
use super::ToolContext;
use crate::agents::endpoint::AsyncStream;
use crate::error::{CoreResult, ErrorCode, IpcError};

pub const SERVER_NAME: &str = "skopos";

const INSTRUCTIONS: &str = "SkoposIDE's tools for the Kubernetes clusters of this chat. Results are trimmed and hold at most 64 KiB; namespaces and Secret values follow what the person allows on each cluster.";

#[derive(Clone)]
struct SkoposServer {
    ctx: Arc<ToolContext>,
}

fn tool_list(ctx: &ToolContext) -> Vec<Tool> {
    read_tools(&ctx.scope)
}

async fn dispatch(ctx: &ToolContext, name: &str, args: JsonObject) -> CallToolResult {
    match call_read(ctx, name, args).await {
        Some(result) => result,
        None => CallToolResult::error(vec![ContentBlock::text(format!("Unknown tool {name}."))]),
    }
}

impl ServerHandler for SkoposServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, crate::VERSION))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tool_list(&self.ctx)))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let CallToolRequestParams {
            name, arguments, ..
        } = request;
        let result = dispatch(&self.ctx, &name, arguments.unwrap_or_default()).await;
        Ok(result.into())
    }
}

/// Serves the chat's tools on `stream` until the agent closes it. The caller has already
/// checked the stream's token line.
pub async fn serve_mcp(stream: Box<dyn AsyncStream>, ctx: Arc<ToolContext>) -> CoreResult<()> {
    let running = SkoposServer { ctx }.serve(stream).await.map_err(|error| {
        IpcError::new(
            ErrorCode::Internal,
            format!("the MCP session did not start: {error}"),
        )
    })?;
    running.waiting().await.map_err(|error| {
        IpcError::new(
            ErrorCode::Internal,
            format!("the MCP session ended unexpectedly: {error}"),
        )
    })?;
    Ok(())
}
