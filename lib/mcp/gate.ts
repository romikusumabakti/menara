import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { getLocalJwksSource } from "@better-auth/oauth-provider/internal";
import { APIError } from "better-auth/api";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  type AssistantViewer,
  AssistantViewerError,
  loadAssistantViewer,
} from "@/lib/assistant/viewer";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { mcpGrantUsage, oauthClients, oauthConsents } from "@/lib/db/schema";
import { isMcpEnabled, MCP_RESOURCE, type McpScope } from "./config";
import { isMcpScope } from "./scopes";

/** Who an MCP request runs for, resolved afresh on every request. */
export type McpCaller = {
  viewer: AssistantViewer;
  clientId: string;
  clientName: string;
  scopes: ReadonlySet<McpScope>;
};

// Bearer tokens only. lib/auth.ts offers no DPoP algorithm, so no token is
// ever DPoP-bound; a request that still presents one (the DPoP scheme, or a
// token carrying cnf.jkt) is refused by better-auth's binding check before any
// proof is read, and a proof that did get that far fails on the empty
// algorithm list. The replay store answers "already seen" for everything, so
// better-auth's database-backed store (whose ids our uuid `verifications.id`
// refuses) is never constructed, let alone written.
const NO_DPOP = {
  signingAlgorithms: [] as string[],
  replayStore: { reserve: () => false },
};

/** The verified access-token claims the gate reads. */
type AccessTokenClaims = { sub?: string; azp?: unknown; scope?: unknown };

/** A JSON-RPC 401/403 carrying the RFC 6750/9728 challenge for `error`. */
function challengeResponse(error: unknown, request: Request): Response {
  const challenge = createResourceServerChallenge(error, MCP_RESOURCE, {
    request,
  });
  if (!challenge) throw error;
  const headers = new Headers(challenge.headers);
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: challenge.message },
      id: null,
    }),
    { status: challenge.statusCode, headers }
  );
}

/** A token that verified but no longer stands for an active grant. */
function invalidToken(request: Request, description: string): Response {
  return challengeResponse(
    new APIError("UNAUTHORIZED", {
      message: description,
      error: "invalid_token",
      error_description: description,
    }),
    request
  );
}

/**
 * Verifies the access token as better-auth's requireMcpAuth does, plus the
 * token type: the signature against this instance's own keys (in process),
 * issuer, audience = MCP_RESOURCE, expiry, `typ: at+jwt` (RFC 9068, so an ID
 * token or another JWT signed with the same keys is refused), an `azp`, and
 * the `read` scope (a token without it gets a 403 insufficient_scope
 * challenge). requireMcpAuth cannot add JWT verify options, hence the
 * lower-level handler with the same inputs. Never reads a cookie.
 */
async function verifyToken(
  request: Request
): Promise<{ claims: AccessTokenClaims } | Response> {
  const context = await auth.$context;
  const issuer = context.baseURL;
  if (!issuer) throw new Error("The auth instance has no base URL");
  let claims: AccessTokenClaims | undefined;
  const response = await createMcpProtectedRequestHandler(
    {
      // The in-process key source requireMcpAuth uses (no JWKS request; its
      // fields are internal to the handler's options type), else the same
      // JWKS URL it falls back to.
      jwksUrl:
        context.getPlugin("jwt")?.options?.jwks?.remoteUrl ?? `${issuer}/jwks`,
      // Menara's auth instance is narrower than the generic AuthContext.
      ...getLocalJwksSource(
        context as unknown as Parameters<typeof getLocalJwksSource>[0],
        request
      ),
      issuer,
      audience: MCP_RESOURCE,
      jwtVerifyOptions: { typ: "at+jwt", requiredClaims: ["azp"] },
      requiredScopes: ["read"],
      dpop: NO_DPOP,
    },
    (_request, verified) => {
      claims = verified;
      return new Response(null, { status: 204 });
    }
  )(request);
  return claims ? { claims } : response;
}

/** The grant (user, client) as it stands now: its scopes and the client's name. */
async function loadGrant(userId: string, clientId: string) {
  const [row] = await db
    .select({
      scopes: oauthConsents.scopes,
      clientName: oauthClients.name,
      disabled: oauthClients.disabled,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .where(
      and(
        eq(oauthConsents.userId, userId),
        eq(oauthConsents.clientId, clientId)
      )
    )
    .limit(1);
  return row;
}

/** How often a grant's "last used" is written, per (user, client). */
const USAGE_TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/**
 * Records that the grant was used, at most once a minute per (user, client):
 * skipped in process within the minute, and the upsert itself only moves a
 * timestamp older than a minute (several app instances). Never fails the call.
 */
function touchGrantUsage(userId: string, clientId: string): void {
  const key = `${userId} ${clientId}`;
  const now = Date.now();
  const last = lastTouched.get(key);
  if (last !== undefined && now - last < USAGE_TOUCH_INTERVAL_MS) return;
  lastTouched.set(key, now);
  db.insert(mcpGrantUsage)
    .values({ userId, clientId, lastUsedAt: new Date(now) })
    .onConflictDoUpdate({
      target: [mcpGrantUsage.userId, mcpGrantUsage.clientId],
      set: { lastUsedAt: sql`excluded.last_used_at` },
      setWhere: lt(mcpGrantUsage.lastUsedAt, sql`now() - interval '1 minute'`),
    })
    .catch((error: unknown) => {
      lastTouched.delete(key);
      console.error("[mcp] failed to record grant usage", error);
    });
}

/** Test hook: forget the in-process usage throttle. */
export function resetGrantUsageThrottle(): void {
  lastTouched.clear();
}

/**
 * Authenticates one request to /api/mcp, or answers it:
 *
 *   1. the instance switch: off → 404, as if Menara had no MCP server;
 *   2. the bearer token (verifyToken): 401 with a resource_metadata
 *      challenge, or 403 insufficient_scope without `read`;
 *   3. the grant: a consent row for (sub, azp) of an enabled client, else 401
 *      invalid_token — a revoked grant stops a still-valid JWT;
 *   4. the user: loadAssistantViewer(sub), so a ban, a role or a membership
 *      change applies to this very call; unknown or banned → 401
 *      invalid_token;
 *   5. the grant's "last used", at most once a minute.
 *
 * The caller's scopes are the token's, narrowed to what the grant holds now.
 */
export async function authenticateMcpRequest(
  request: Request
): Promise<McpCaller | Response> {
  if (!(await isMcpEnabled())) {
    return new Response("Not Found", { status: 404 });
  }

  const verified = await verifyToken(request);
  if (verified instanceof Response) return verified;
  const { claims } = verified;
  const userId = claims.sub;
  const clientId = typeof claims.azp === "string" ? claims.azp : undefined;
  if (!userId || !clientId) {
    return invalidToken(request, "access token has no user or client");
  }

  const grant = await loadGrant(userId, clientId);
  if (!grant || grant.disabled === true) {
    return invalidToken(request, "the grant is no longer active");
  }

  let viewer: AssistantViewer;
  try {
    viewer = await loadAssistantViewer(userId);
  } catch (error) {
    if (error instanceof AssistantViewerError) {
      return invalidToken(request, "the user can no longer sign in");
    }
    throw error;
  }

  const granted = new Set(grant.scopes);
  const tokenScopes =
    typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  const scopes = new Set(
    tokenScopes.filter(
      (scope): scope is McpScope => isMcpScope(scope) && granted.has(scope)
    )
  );
  if (!scopes.has("read")) {
    return invalidToken(request, "the grant no longer includes read");
  }

  touchGrantUsage(userId, clientId);
  return {
    viewer,
    clientId,
    clientName: grant.clientName ?? clientId,
    scopes,
  };
}
