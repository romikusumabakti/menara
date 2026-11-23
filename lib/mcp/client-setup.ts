// How each supported MCP client is pointed at this instance (Account ›
// Connected apps, docs/mcp.md). Dependency-free, so the account page imports
// it. The client names are proper names, not copy, so they live here rather
// than in messages/*.json; this is the one module that names them
// (tests/no-vendor-names.test.ts excludes it).

/** The name an agent lists this server under: the instance name, slugged. */
export function mcpServerName(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "mcp";
}

export type McpClientSetup = {
  id: "claude-code" | "zed" | "claude-desktop";
  /** The client's own name. */
  label: string;
  /**
   * command: a shell command; json: a settings fragment; connector: steps in
   * the client's settings, with the URL to paste (`value`).
   */
  kind: "command" | "json" | "connector";
  /** What the copy button copies. */
  value: string;
};

/** The setup snippets for the server named `serverName` at `url` (MCP_RESOURCE). */
export function mcpClientSetups(
  serverName: string,
  url: string
): McpClientSetup[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      kind: "command",
      value: `claude mcp add --transport http ${serverName} ${url}`,
    },
    {
      id: "zed",
      label: "Zed",
      kind: "json",
      value: JSON.stringify({ [serverName]: { url } }, null, 2),
    },
    {
      id: "claude-desktop",
      label: "claude.ai / Claude Desktop",
      kind: "connector",
      value: url,
    },
  ];
}
