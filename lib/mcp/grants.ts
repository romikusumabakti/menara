import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import {
  instanceSettings,
  mcpGrantUsage,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  users,
} from "@/lib/db/schema";
import { CodedHTTPException } from "@/server/errors";
import { invalidateMcpEnabled } from "./config";
import { isMcpScope } from "./scopes";

/**
 * One user's grant to one agent (an OAuth client): what the consent page
 * recorded, plus when the agent last called /api/mcp with it.
 */
export type McpGrant = {
  userId: string;
  userName: string;
  clientId: string;
  clientName: string;
  /** Where the client is published (its metadata URL's host), else "". */
  clientHost: string;
  scopes: string[];
  approvedAt: string;
  lastUsedAt: string | null;
};

/** The host of a URL, or null when it is not one (a registered client's random id). */
function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * The grants matching `where`, one per (user, client), newest approval first.
 * Inner joins: a consent whose client or user is gone is no grant, and a usage
 * row without a consent (mcp_grant_usage has no foreign key to the client) is
 * never listed.
 */
async function selectGrants(where?: SQL): Promise<McpGrant[]> {
  const rows = await db
    .select({
      userId: users.id,
      userName: users.name,
      clientId: oauthClients.clientId,
      clientName: oauthClients.name,
      clientUri: oauthClients.uri,
      redirectUris: oauthClients.redirectUris,
      scopes: oauthConsents.scopes,
      approvedAt: oauthConsents.updatedAt,
      lastUsedAt: mcpGrantUsage.lastUsedAt,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .innerJoin(users, eq(users.id, oauthConsents.userId))
    .leftJoin(
      mcpGrantUsage,
      and(
        eq(mcpGrantUsage.userId, oauthConsents.userId),
        eq(mcpGrantUsage.clientId, oauthConsents.clientId)
      )
    )
    .where(where)
    .orderBy(desc(oauthConsents.updatedAt));

  // better-auth keeps one consent per (user, client, reference); Menara sets
  // no reference, so duplicates are unexpected, but they would fold into one
  // grant holding every scope.
  const grants = new Map<string, McpGrant>();
  for (const row of rows) {
    const key = `${row.userId} ${row.clientId}`;
    const scopes = row.scopes.filter(isMcpScope);
    const existing = grants.get(key);
    if (existing) {
      existing.scopes = [...new Set([...existing.scopes, ...scopes])];
      continue;
    }
    grants.set(key, {
      userId: row.userId,
      userName: row.userName,
      clientId: row.clientId,
      clientName: row.clientName ?? row.clientId,
      clientHost:
        hostOf(row.clientId) ??
        hostOf(row.clientUri) ??
        hostOf(row.redirectUris[0]) ??
        "",
      scopes,
      approvedAt: row.approvedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    });
  }
  return [...grants.values()];
}

/** The caller's own grants (Account › Connected apps). */
export function listGrantsFor(userId: string): Promise<McpGrant[]> {
  return selectGrants(eq(oauthConsents.userId, userId));
}

/** Every user's grants (Admin › Instance › MCP). The caller checks the permission. */
export function listAllGrants(): Promise<McpGrant[]> {
  return selectGrants();
}

/**
 * Revokes a user's grant to a client, at once: in one transaction it deletes
 * the consent (the /api/mcp gate refuses the next call even with a still-valid
 * JWT), revokes the refresh tokens (no new access token), deletes the access
 * token rows and the "last used" row. Then records `mcp.grantRevoked`.
 *
 * 404 `mcpGrantNotFound` when the user holds no grant for the client, so the
 * account route cannot tell someone else's grant from a missing one.
 */
export async function revokeGrant(
  actorId: string,
  userId: string,
  clientId: string
): Promise<void> {
  const [grant] = await selectGrants(
    and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId))
  );
  if (!grant) {
    throw new CodedHTTPException(
      404,
      "mcpGrantNotFound",
      "This app has no access to revoke."
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(oauthConsents)
      .where(
        and(
          eq(oauthConsents.userId, userId),
          eq(oauthConsents.clientId, clientId)
        )
      );
    await tx
      .update(oauthRefreshTokens)
      .set({ revoked: sql`now()` })
      .where(
        and(
          eq(oauthRefreshTokens.userId, userId),
          eq(oauthRefreshTokens.clientId, clientId),
          isNull(oauthRefreshTokens.revoked)
        )
      );
    await tx
      .delete(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.userId, userId),
          eq(oauthAccessTokens.clientId, clientId)
        )
      );
    await tx
      .delete(mcpGrantUsage)
      .where(
        and(
          eq(mcpGrantUsage.userId, userId),
          eq(mcpGrantUsage.clientId, clientId)
        )
      );
  });

  await recordActivity({
    actorId,
    action: "mcp.grantRevoked",
    data: { client: grant.clientName, userName: grant.userName },
  });
}

/**
 * Turns the MCP server on or off for the whole instance and drops the cached
 * switch, so this process answers the new way at once (others within 5 s).
 * The caller checks the permission.
 */
export async function setMcpEnabled(
  actorId: string,
  enabled: boolean
): Promise<void> {
  await db
    .update(instanceSettings)
    .set({ mcpEnabled: enabled })
    .where(eq(instanceSettings.id, 1));
  invalidateMcpEnabled();
  await recordActivity({
    actorId,
    action: "instance.mcpToggled",
    data: { enabled: enabled ? "true" : "false" },
  });
}

/**
 * Records `mcp.grantApproved` after better-auth's POST /oauth2/consent
 * accepted (lib/auth's after hook). `oauthQuery` is the signed authorize
 * query the consent page sent, already verified by the plugin. Only logged
 * when the consent row is really there (an accept that bounced to a fresh
 * sign-in stored nothing yet). Never throws.
 */
export async function recordGrantApproved(
  userId: string,
  oauthQuery: string
): Promise<void> {
  try {
    const clientId = new URLSearchParams(oauthQuery).get("client_id");
    if (!clientId) return;
    const [grant] = await selectGrants(
      and(
        eq(oauthConsents.userId, userId),
        eq(oauthConsents.clientId, clientId)
      )
    );
    if (!grant) return;
    await recordActivity({
      actorId: userId,
      action: "mcp.grantApproved",
      data: { client: grant.clientName },
    });
  } catch (error) {
    console.error("[mcp] failed to record the grant approval", error);
  }
}
