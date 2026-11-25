import { describe, expect, it } from "vitest";
import { mcpClientSetups, mcpServerName } from "@/lib/mcp/client-setup";

// The setup snippets on Account › Connected apps: built from the instance's
// name (slugged) and its MCP URL, never a hard-coded product name.

const URL = "https://ops.example.com/api/mcp";

describe("MCP client setup", () => {
  it("slugs the instance name into the server name", () => {
    expect(mcpServerName("Menara")).toBe("menara");
    expect(mcpServerName("Acme Ops — Staging")).toBe("acme-ops-staging");
    expect(mcpServerName("  ***  ")).toBe("mcp");
    expect(mcpServerName("x".repeat(60))).toHaveLength(40);
  });

  it("gives each client its own steps, ending in the browser approval", () => {
    const setups = mcpClientSetups("acme-ops", URL);
    expect(setups.map((s) => [s.id, s.steps.map((step) => step.text)])).toEqual(
      [
        ["claude-code", ["addCommand", "loginCommand", "approve"]],
        ["zed", ["addRemoteServer", "approve"]],
        ["claude-desktop", ["addConnector", "approve"]],
      ]
    );
    const [claudeCode, zed, connector] = setups;
    // User scope: the server is there in every project, not just the folder
    // the command ran in.
    expect(claudeCode?.steps[0]?.snippet).toBe(
      `claude mcp add --scope user --transport http acme-ops ${URL}`
    );
    expect(claudeCode?.steps[1]?.snippet).toBe("claude mcp login acme-ops");
    // What Zed's Add Remote Server dialog takes: no headers, so Zed runs OAuth.
    expect(JSON.parse(zed?.steps[0]?.snippet ?? "")).toEqual({
      "acme-ops": { url: URL },
    });
    expect(connector?.steps[0]?.snippet).toBe(URL);
    for (const setup of setups) {
      expect(setup.steps.at(-1)).toEqual({ text: "approve" });
    }
  });
});
