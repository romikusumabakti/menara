import {
  hostHeaderValidation,
  originValidation,
} from "@modelcontextprotocol/hono";
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isMcpEnabled, MCP_RESOURCE } from "@/lib/mcp/config";
import { authenticateMcpRequest, type McpCaller } from "@/lib/mcp/gate";
import { consumeMcpQuota, type McpCallKind } from "@/lib/mcp/rate-limit";
import { createMenaraMcpServer } from "@/lib/mcp/server";
import { isWriteTool } from "@/lib/mcp/write-tools";
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

/** A JSON-RPC error response with no request id (the request was refused whole). */
function jsonRpcError(
  c: Context<AppEnv>,
  status: 413 | 429,
  message: string,
  data?: Record<string, unknown>,
  headers?: Record<string, string>
) {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message, ...(data && { data }) },
      id: null,
    },
    status,
    headers
  );
}

// The SDK's own default (maxRequestBodySize), enforced before the token is
// even read, so an oversized body costs no verification.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The name a tools/call body calls, if it is one. */
function calledToolOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (method !== "tools/call" || typeof params !== "object" || !params) {
    return undefined;
  }
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Whether the request counts against the write quota: a 2026-07-28 request
 * names its tool in `Mcp-Name` (the handler refuses a header that disagrees
 * with the body); a 2025-era one carries only the body, which is read here
 * from a copy.
 */
async function callKindOf(request: Request): Promise<McpCallKind> {
  const header = request.headers.get("mcp-name");
  if (header !== null) return isWriteTool(header) ? "write" : "read";
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  const name = calledToolOf(body);
  return name !== undefined && isWriteTool(name) ? "write" : "read";
}

/** Mounted at /api/mcp. */
export const mcpRouter = publicRouter()
  .use(hostHeaderValidation([PUBLIC_HOSTNAME]))
  .use(originValidation([PUBLIC_HOSTNAME]))
  .post(
    "/",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => jsonRpcError(c, 413, "Request body too large."),
    }),
    async (c) => {
      const caller = await authenticateMcpRequest(c.req.raw);
      if (caller instanceof Response) return caller;
      const quota = await consumeMcpQuota(
        caller.viewer.userId,
        caller.clientId,
        await callKindOf(c.req.raw)
      );
      if (!quota.ok) {
        return jsonRpcError(
          c,
          429,
          "Rate limit exceeded.",
          {
            code: "mcpRateLimited",
            params: { retryAfterSeconds: quota.retryAfterSeconds },
          },
          { "Retry-After": String(quota.retryAfterSeconds) }
        );
      }
      return handler.fetch(c.req.raw, {
        authInfo: authInfoOf(c.req.raw, caller),
      });
    }
  )
  .get("/", methodNotAllowed)
  .delete("/", methodNotAllowed);
