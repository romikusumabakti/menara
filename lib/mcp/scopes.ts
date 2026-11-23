// Dependency-free, so the consent page can import the scope list without
// pulling lib/mcp/config's database client into the browser bundle.

/**
 * What an agent may ask for. `read` is required on every grant; the write
 * scopes widen it. `offline_access` (refresh tokens) is an authorization
 * server scope and is not listed here.
 */
export const MCP_SCOPES = [
  "read",
  "database:read",
  "issues:write",
  "deploys:write",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Whether `scope` is one of MCP_SCOPES. */
export function isMcpScope(scope: string): scope is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(scope);
}

/** Where better-auth sends the user to approve an agent. */
export const MCP_CONSENT_PATH = "/oauth/consent";
