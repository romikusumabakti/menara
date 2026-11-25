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

/** One numbered step; its wording is `connectedApps.steps.<text>`. */
export type McpSetupStep = {
  text:
    | "addCommand"
    | "loginCommand"
    | "addRemoteServer"
    | "addConnector"
    | "approve";
  /** What the step's copy button copies; absent when there is nothing to paste. */
  snippet?: string;
};

export type McpClientSetup = {
  id: "claude-code" | "zed" | "claude-desktop";
  /** The client's own name. */
  label: string;
  steps: McpSetupStep[];
};

/**
 * The steps for the server named `serverName` at `url` (MCP_RESOURCE). Each
 * client's own way in: Claude Code's CLI (user scope, so the server is there
 * in every project, then `claude mcp login`), Zed's Add Remote Server dialog
 * (it takes the same `{ name: { url } }` it writes to `context_servers`), and
 * the claude.ai custom connector. None needs a token: each opens the browser
 * for OAuth, which ends in the shared `approve` step.
 */
export function mcpClientSetups(
  serverName: string,
  url: string
): McpClientSetup[] {
  const approve: McpSetupStep = { text: "approve" };
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      steps: [
        {
          text: "addCommand",
          snippet: `claude mcp add --scope user --transport http ${serverName} ${url}`,
        },
        { text: "loginCommand", snippet: `claude mcp login ${serverName}` },
        approve,
      ],
    },
    {
      id: "zed",
      label: "Zed",
      steps: [
        {
          text: "addRemoteServer",
          snippet: JSON.stringify({ [serverName]: { url } }, null, 2),
        },
        approve,
      ],
    },
    {
      id: "claude-desktop",
      label: "claude.ai / Claude Desktop",
      steps: [{ text: "addConnector", snippet: url }, approve],
    },
  ];
}
