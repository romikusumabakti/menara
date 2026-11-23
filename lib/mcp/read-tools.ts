import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { createAutoToolContext } from "@/lib/assistant/auto-context";
import {
  autoToolCatalog,
  type CatalogEntry,
  executeTool,
} from "@/lib/assistant/tool-defs";
import type { ToolResult } from "@/lib/assistant/tools/code";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { errorSummary } from "@/lib/error-summary";
import { effectiveTimeZone } from "@/lib/timezone";
import type { McpCaller } from "./gate";
import type { McpScope } from "./scopes";

// Menara's read tools over MCP: the Assistant's automatic-mode tools
// (lib/assistant/tool-defs#autoToolCatalog), with the same cores, per-viewer
// scoping, secret/PII filters and limits. The catalog already leaves out what
// the viewer's role may not use (gated data tools; the database tools for
// roles below engineer); the grant's scopes narrow it further.

/** The tools that need `database:read` on top of `read`. */
const DATABASE_TOOLS = new Set<string>(["list_tables", "query_database"]);

/** The scope a catalog entry needs. */
export function scopeFor(name: string): McpScope {
  return DATABASE_TOOLS.has(name) ? "database:read" : "read";
}

/** The catalog entries the caller may call: role (catalog) and scope. */
export function readToolsFor(caller: McpCaller): CatalogEntry[] {
  return autoToolCatalog(caller.viewer).filter((entry) =>
    caller.scopes.has(scopeFor(entry.name))
  );
}

async function userTimeZone(userId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return effectiveTimeZone(row);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A tool result as MCP returns it. */
export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  if (!result.ok) {
    return { isError: true, content: [{ type: "text", text: result.error }] };
  }
  const text = JSON.stringify(result.data);
  return {
    // structuredContent must be a JSON object; every catalog tool returns
    // one, but a bare value is still served as text.
    ...(isRecord(result.data) ? { structuredContent: result.data } : {}),
    content: [{ type: "text", text }],
  };
}

/** One line per call: never the input, the output or a token. */
export function logCall(
  tool: string,
  caller: McpCaller,
  startedAt: number,
  outcome: "ok" | "error"
): void {
  const ms = Math.round(performance.now() - startedAt);
  console.info(
    `[mcp] tool=${tool} user=${caller.viewer.userId} client=${caller.clientId} ms=${ms} outcome=${outcome}`
  );
}

/** Registers the read tools the caller may call on `server`. */
export function registerReadTools(server: McpServer, caller: McpCaller): void {
  // The tool context of this request, built on the first call (stateless:
  // one MCP server per HTTP request).
  let context: ReturnType<typeof createAutoToolContext> | undefined;
  const contextOf = () => {
    context ??= userTimeZone(caller.viewer.userId).then((timeZone) =>
      createAutoToolContext(caller.viewer, { timeZone })
    );
    return context;
  };

  for (const entry of readToolsFor(caller)) {
    server.registerTool(
      entry.name,
      {
        description: entry.description,
        inputSchema: entry.input,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (input: unknown) => {
        const startedAt = performance.now();
        try {
          const result = await executeTool(
            entry.name,
            input,
            await contextOf()
          );
          logCall(entry.name, caller, startedAt, result.ok ? "ok" : "error");
          return toCallToolResult(result);
        } catch (error) {
          // executeTool catches its own failures; this is the context
          // (projects, time zone) failing to load. Its text stays here.
          console.error(
            `[mcp] tool ${entry.name} failed: ${errorSummary(error)}`
          );
          logCall(entry.name, caller, startedAt, "error");
          return toCallToolResult({
            ok: false,
            error: `${entry.name} failed unexpectedly`,
            meta: {},
          });
        }
      }
    );
  }
}
