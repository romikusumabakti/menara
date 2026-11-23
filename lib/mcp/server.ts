import { McpServer } from "@modelcontextprotocol/server";
import { bootBrandName } from "@/lib/instance-branding";
import { MENARA_VERSION } from "@/lib/version";
import type { McpCaller } from "./gate";
import { registerReadTools } from "./read-tools";
import { registerWriteTools } from "./write-tools";

/**
 * The MCP server for one authenticated request (createMcpHandler builds one
 * per request): only the tools the caller's role and scopes allow are
 * registered, so a tool outside them is neither listed nor callable.
 */
export function createMenaraMcpServer(caller: McpCaller): McpServer {
  const server = new McpServer({
    name: "menara",
    // The instance name, as better-auth's appName and TOTP issuer use it.
    title: bootBrandName(),
    version: MENARA_VERSION,
  });
  registerReadTools(server, caller);
  registerWriteTools(server, caller);
  return server;
}
