import {
  hostHeaderValidation,
  originValidation,
} from "@modelcontextprotocol/hono";
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { isMcpEnabled, MCP_RESOURCE } from "@/lib/mcp/config";
import { authenticateMcpRequest, type McpCaller } from "@/lib/mcp/gate";
import { createMenaraMcpServer } from "@/lib/mcp/server";
import type { AppEnv } from "@/server/context";
import { publicRouter } from "@/server/router";

// The MCP endpoint (Streamable HTTP, stateless). Public to the session
// routers on purpose: agents authenticate with an OAuth bearer token on every
// request (lib/mcp/gate), never with a session cookie, which is also why the
// CSRF guard exempts this path. The SDK's default `legacy: "stateless"`
// keeps 2025-era clients working next to 2026-07-28 ones.

const handler = createMcpHandler(({ authInfo }) =>
  createMenaraMcpServer(callerOf(authInfo))
);

const CALLER = "menaraCaller";

/** The caller authenticateMcpRequest resolved, handed through authInfo. */
function callerOf(authInfo: AuthInfo | undefined): McpCaller {
  const caller = authInfo?.extra?.[CALLER];
  if (!caller) throw new Error("MCP request without an authenticated caller");
  return caller as McpCaller;
}

function authInfoOf(request: Request, caller: McpCaller): AuthInfo {
  const authorization = request.headers.get("authorization") ?? "";
  return {
    token: authorization.replace(/^Bearer\s+/i, ""),
    clientId: caller.clientId,
    scopes: [...caller.scopes],
    resource: new URL(MCP_RESOURCE),
    extra: { [CALLER]: caller },
  };
}

// DNS-rebinding and cross-site protection: the Host must be this instance's
// public host, and an Origin, when a browser sends one, too.
const PUBLIC_HOSTNAME = new URL(MCP_RESOURCE).hostname;

// No sessions, so nothing to GET (a stream) or DELETE. While the instance
// switch is off the endpoint does not exist, whatever the method.
const methodNotAllowed = async (c: Context<AppEnv>) => {
  if (!(await isMcpEnabled())) return c.text("Not Found", 404);
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    },
    405,
    { Allow: "POST" }
  );
};

/** Mounted at /api/mcp. */
export const mcpRouter = publicRouter()
  .use(hostHeaderValidation([PUBLIC_HOSTNAME]))
  .use(originValidation([PUBLIC_HOSTNAME]))
  .post("/", async (c) => {
    const caller = await authenticateMcpRequest(c.req.raw);
    if (caller instanceof Response) return caller;
    // Per-caller limits go here: after authentication, before the handler.
    return handler.fetch(c.req.raw, {
      authInfo: authInfoOf(c.req.raw, caller),
    });
  })
  .get("/", methodNotAllowed)
  .delete("/", methodNotAllowed);
