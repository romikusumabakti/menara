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

  it("builds each client's snippet from the name and the URL", () => {
    const setups = mcpClientSetups("acme-ops", URL);
    expect(setups.map((s) => [s.id, s.kind])).toEqual([
      ["claude-code", "command"],
      ["zed", "json"],
      ["claude-desktop", "connector"],
    ]);
    expect(setups[0]?.value).toBe(
      `claude mcp add --transport http acme-ops ${URL}`
    );
    expect(JSON.parse(setups[1]?.value ?? "")).toEqual({
      "acme-ops": { url: URL },
    });
    expect(setups[2]?.value).toBe(URL);
  });
});
