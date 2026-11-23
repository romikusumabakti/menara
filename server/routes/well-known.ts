import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { Context, Next } from "hono";
import { auth } from "@/lib/auth";
import { isMcpEnabled } from "@/lib/mcp/config";
import type { AppEnv } from "@/server/context";
import { publicRouter } from "@/server/router";

// The OAuth discovery documents MCP agents read before they ask a user for
// access: the protected resource metadata (RFC 9728) for /api/mcp, and the
// authorization server metadata (RFC 8414) for better-auth's issuer
// `${BETTER_AUTH_URL}/api/auth`. better-auth's mcp and oauth-provider plugins
// build them; these routes only decide where they are served and add:
//
//   - the instance switch: while instance_settings.mcp_enabled is false every
//     document is a 404, as if Menara had no MCP server;
//   - `Access-Control-Allow-Origin: *`, so browser-based agents can read them
//     (no credentials are involved);
//   - no `dpop_signing_alg_values_supported` while lib/auth.ts accepts no
//     DPoP algorithm: an empty list would still read as "DPoP offered".
//
// Public on purpose: discovery happens before an agent holds any token.

const PUBLIC_DOCUMENT_HEADERS = { "Access-Control-Allow-Origin": "*" };

async function mcpSwitch(c: Context<AppEnv>, next: Next) {
  if (!(await isMcpEnabled())) return c.notFound();
  await next();
}

async function discoveryDocument(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = (await response.json()) as Record<string, unknown>;
  const dpop = body.dpop_signing_alg_values_supported;
  if (Array.isArray(dpop) && dpop.length === 0) {
    delete body.dpop_signing_alg_values_supported;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  for (const [name, value] of Object.entries(PUBLIC_DOCUMENT_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers,
  });
}

// The document as a GET: Hono answers a HEAD through the GET route and drops
// the body itself, while better-auth would hand back a bodyless HEAD answer.
const asGet = (request: Request) =>
  new Request(request.url, { headers: request.headers });

// better-auth serves these from its plugins' onRequest hooks by pathname, so
// the raw request is enough.
const fromAuth = async (c: Context<AppEnv>) =>
  discoveryDocument(await auth.handler(asGet(c.req.raw)));

// The issuer has a path, so its RFC 8414 document is path-inserted
// (/.well-known/oauth-authorization-server/api/auth). The root URL serves the
// same document for clients that probe only the root.
const authServerMetadata = oauthProviderAuthServerMetadata(auth);

/** Mounted at /.well-known. */
export const wellKnownRouter = publicRouter()
  .get("/oauth-protected-resource", mcpSwitch, fromAuth)
  .get("/oauth-protected-resource/api/mcp", mcpSwitch, fromAuth)
  .get("/oauth-authorization-server", mcpSwitch, async (c) =>
    discoveryDocument(await authServerMetadata(asGet(c.req.raw)))
  )
  .get("/oauth-authorization-server/api/auth", mcpSwitch, fromAuth);

/**
 * Mounted at /api/auth/.well-known, ahead of better-auth's catch-all: the
 * path-appended form of the same document, which better-auth also answers.
 */
export const authWellKnownRouter = publicRouter().get(
  "/oauth-authorization-server",
  mcpSwitch,
  fromAuth
);
