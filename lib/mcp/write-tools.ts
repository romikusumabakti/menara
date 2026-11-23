import type { McpServer } from "@modelcontextprotocol/server";
import type { McpCaller } from "./gate";

/**
 * Registers the write tools the caller's scopes allow (`issues:write`,
 * `deploys:write`). None yet: the write tools arrive with their own change.
 */
export function registerWriteTools(
  _server: McpServer,
  _caller: McpCaller
): void {}
