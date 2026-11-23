import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/lib/db/schema";

// MCP grants (lib/mcp/grants.ts and the connected-apps routes) against a real
// Postgres: listing joins consents to clients and users (and ignores usage
// rows without a consent: mcp_grant_usage has no foreign key to the client),
// revoking clears the consent, refresh tokens, access tokens and usage in one
// go, the instance switch, and the activity rows. Same setup as
// issue-writes-scratch.test.ts: the local menara-postgres container, a scratch
// database migrated with `menara migrate` and dropped afterwards.
//
//   MCP_GRANTS_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/mcp-grants-scratch.test.ts
const enabled = process.env.MCP_GRANTS_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "mcp_grants_scratch";

const session = vi.hoisted(() => ({
  user: { id: "", role: "admin" },
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: session.user,
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});

function psql(db: string, args: string[]) {
  return execFileSync(
    "podman",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

const ADMIN = "00000000-0000-7000-8000-00000000e001";
const ALICE = "00000000-0000-7000-8000-00000000e002";
const BOB = "00000000-0000-7000-8000-00000000e003";
// A CIMD client (its id is its metadata URL) and a registered one.
const AGENT = "https://agent.example.com/oauth/client.json";
const TOOL = "r4nd0m-client-id";
const GONE = "https://gone.example.com/client.json";

describe.skipIf(!enabled)("MCP grants on Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let d: ReturnType<typeof drizzle>;
  let previousUrl: string | undefined;
  let app: typeof import("@/server/app")["app"];
  let grants: typeof import("@/lib/mcp/grants");
  let config: typeof import("@/lib/mcp/config");

  const as = (id: string, role: string) => {
    session.user = { id, role };
  };
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const hour = (offset: number) => new Date(Date.now() + offset * 3_600_000);

  /** A consent plus one refresh and one access token, as better-auth stores them. */
  async function seedGrant(
    userId: string,
    clientId: string,
    scopes: string[],
    approvedAt: Date
  ) {
    await d.insert(schema.oauthConsents).values({
      id: randomUUID(),
      clientId,
      userId,
      scopes,
      createdAt: approvedAt,
      updatedAt: approvedAt,
    });
    const refreshId = randomUUID();
    await d.insert(schema.oauthRefreshTokens).values({
      id: refreshId,
      token: randomUUID(),
      clientId,
      userId,
      scopes,
      expiresAt: hour(24),
      createdAt: approvedAt,
    });
    await d.insert(schema.oauthAccessTokens).values({
      id: randomUUID(),
      token: randomUUID(),
      clientId,
      userId,
      refreshId,
      scopes,
      expiresAt: hour(1),
      createdAt: approvedAt,
    });
  }

  const rowsFor = async (userId: string, clientId: string) => ({
    consents: await d
      .select()
      .from(schema.oauthConsents)
      .where(
        and(
          eq(schema.oauthConsents.userId, userId),
          eq(schema.oauthConsents.clientId, clientId)
        )
      ),
    refresh: await d
      .select()
      .from(schema.oauthRefreshTokens)
      .where(
        and(
          eq(schema.oauthRefreshTokens.userId, userId),
          eq(schema.oauthRefreshTokens.clientId, clientId)
        )
      ),
    access: await d
      .select()
      .from(schema.oauthAccessTokens)
      .where(
        and(
          eq(schema.oauthAccessTokens.userId, userId),
          eq(schema.oauthAccessTokens.clientId, clientId)
        )
      ),
    usage: await d
      .select()
      .from(schema.mcpGrantUsage)
      .where(
        and(
          eq(schema.mcpGrantUsage.userId, userId),
          eq(schema.mcpGrantUsage.clientId, clientId)
        )
      ),
  });

  const activity = (action: string) =>
    d
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.action, action));

  beforeAll(async () => {
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    const url = `postgres://postgres:${password}@127.0.0.1:5432/${DB_NAME}`;
    psql("postgres", [
      "-c",
      `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      "-c",
      `CREATE DATABASE ${DB_NAME}`,
    ]);
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    client = postgres(url, {
      max: 1,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    d = drizzle({ client });

    for (const [id, name, role] of [
      [ADMIN, "Admin", "admin"],
      [ALICE, "Alice", "engineer"],
      [BOB, "Bob", "qa"],
    ] as const) {
      await d
        .insert(schema.users)
        .values({ id, name, email: `${role}@example.com`, role });
    }
    for (const [clientId, name] of [
      [AGENT, "Acme Agent"],
      [TOOL, "Acme Tool"],
    ] as const) {
      await d.insert(schema.oauthClients).values({
        id: randomUUID(),
        clientId,
        name,
        redirectUris: ["http://127.0.0.1:8976/callback"],
      });
    }

    ({ app } = await import("@/server/app"));
    grants = await import("@/lib/mcp/grants");
    config = await import("@/lib/mcp/config");
  });

  beforeEach(async () => {
    await client`delete from oauth_access_tokens`;
    await client`delete from oauth_refresh_tokens`;
    await client`delete from oauth_consents`;
    await client`delete from mcp_grant_usage`;
    await client`delete from activity_log`;
    await seedGrant(
      ALICE,
      AGENT,
      ["offline_access", "read", "issues:write"],
      hour(-3)
    );
    await seedGrant(ALICE, TOOL, ["read"], hour(-2));
    await seedGrant(BOB, AGENT, ["read", "database:read"], hour(-1));
    await d.insert(schema.mcpGrantUsage).values([
      { userId: ALICE, clientId: AGENT, lastUsedAt: hour(-0.5) },
      // Usage of a client that no longer exists: never listed.
      { userId: ALICE, clientId: GONE, lastUsedAt: hour(-0.5) },
    ]);
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("lists only the caller's grants", async () => {
    as(ALICE, "engineer");
    const res = await send("GET", "/api/account/connected-apps");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Awaited<
      ReturnType<typeof grants.listGrantsFor>
    >;
    // Newest approval first; offline_access is not an MCP scope to show.
    expect(list.map((g) => [g.clientId, g.clientName, g.scopes])).toEqual([
      [TOOL, "Acme Tool", ["read"]],
      [AGENT, "Acme Agent", ["read", "issues:write"]],
    ]);
    const agent = list.find((g) => g.clientId === AGENT);
    expect(agent?.clientHost).toBe("agent.example.com");
    expect(agent?.userName).toBe("Alice");
    expect(agent?.lastUsedAt).not.toBeNull();
    // A registered client's id is no URL: the redirect's host stands in.
    expect(list.find((g) => g.clientId === TOOL)?.clientHost).toBe(
      "127.0.0.1:8976"
    );
    expect(list.find((g) => g.clientId === TOOL)?.lastUsedAt).toBeNull();

    const all = await grants.listAllGrants();
    expect(all.map((g) => [g.userName, g.clientId])).toEqual([
      ["Bob", AGENT],
      ["Alice", TOOL],
      ["Alice", AGENT],
    ]);
  });

  it("revoke removes consent, revokes refresh tokens, deletes access tokens and usage", async () => {
    await grants.revokeGrant(ADMIN, ALICE, AGENT);

    const after = await rowsFor(ALICE, AGENT);
    expect(after.consents).toEqual([]);
    expect(after.refresh).toHaveLength(1);
    expect(after.refresh[0]?.revoked).toBeInstanceOf(Date);
    expect(after.access).toEqual([]);
    expect(after.usage).toEqual([]);

    // Alice's other client and Bob's grant to the same client are untouched.
    for (const [userId, clientId] of [
      [ALICE, TOOL],
      [BOB, AGENT],
    ] as const) {
      const rows = await rowsFor(userId, clientId);
      expect(rows.consents).toHaveLength(1);
      expect(rows.refresh[0]?.revoked).toBeNull();
      expect(rows.access).toHaveLength(1);
    }
    expect((await grants.listGrantsFor(ALICE)).map((g) => g.clientId)).toEqual([
      TOOL,
    ]);

    // Nothing left to revoke.
    await expect(grants.revokeGrant(ADMIN, ALICE, AGENT)).rejects.toMatchObject(
      { status: 404, code: "mcpGrantNotFound" }
    );
  });

  it("a user cannot revoke another user's grant via the account route", async () => {
    as(BOB, "qa");
    // TOOL is Alice's only: 404, as for a client that does not exist.
    const res = await send(
      "DELETE",
      `/api/account/connected-apps/${encodeURIComponent(TOOL)}`
    );
    expect(res.status).toBe(404);
    expect((await rowsFor(ALICE, TOOL)).consents).toHaveLength(1);

    // Bob's own grant to AGENT, whose id is a URL: revoked, Alice's stays.
    const own = await send(
      "DELETE",
      `/api/account/connected-apps/${encodeURIComponent(AGENT)}`
    );
    expect(own.status).toBe(204);
    expect((await rowsFor(BOB, AGENT)).consents).toEqual([]);
    expect((await rowsFor(ALICE, AGENT)).consents).toHaveLength(1);
  });

  it("only instance managers can toggle and list all grants", async () => {
    as(ALICE, "engineer");
    expect((await send("GET", "/api/instance/mcp")).status).toBe(403);
    expect(
      (await send("PUT", "/api/instance/mcp", { enabled: true })).status
    ).toBe(403);
    expect(
      (
        await send(
          "DELETE",
          `/api/instance/mcp/grants/${BOB}/${encodeURIComponent(AGENT)}`
        )
      ).status
    ).toBe(403);
    expect((await rowsFor(BOB, AGENT)).consents).toHaveLength(1);

    as(ADMIN, "admin");
    expect(await config.isMcpEnabled()).toBe(false);
    const on = await send("PUT", "/api/instance/mcp", { enabled: true });
    expect(on.status).toBe(200);
    // The cached switch was dropped: the change is seen at once.
    expect(await config.isMcpEnabled()).toBe(true);
    const page = (await (await send("GET", "/api/instance/mcp")).json()) as {
      enabled: boolean;
      grants: unknown[];
    };
    expect(page.enabled).toBe(true);
    expect(page.grants).toHaveLength(3);

    const revoked = await send(
      "DELETE",
      `/api/instance/mcp/grants/${BOB}/${encodeURIComponent(AGENT)}`
    );
    expect(revoked.status).toBe(204);
    expect((await rowsFor(BOB, AGENT)).consents).toEqual([]);

    await send("PUT", "/api/instance/mcp", { enabled: false });
    expect(await config.isMcpEnabled()).toBe(false);
  });

  it("records mcp.grantApproved, mcp.grantRevoked and instance.mcpToggled", async () => {
    const query = (clientId: string) =>
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        scope: "read",
      }).toString();
    await grants.recordGrantApproved(ALICE, query(AGENT));
    // No consent stored (an accept that bounced to a fresh sign-in): no row.
    await grants.recordGrantApproved(BOB, query(TOOL));
    await grants.revokeGrant(ADMIN, BOB, AGENT);
    await grants.setMcpEnabled(ADMIN, true);
    await grants.setMcpEnabled(ADMIN, false);

    const approved = await activity("mcp.grantApproved");
    expect(approved.map((r) => [r.actorId, r.data])).toEqual([
      [ALICE, { client: "Acme Agent" }],
    ]);
    const revoked = await activity("mcp.grantRevoked");
    expect(revoked.map((r) => [r.actorId, r.data])).toEqual([
      [ADMIN, { client: "Acme Agent", userName: "Bob" }],
    ]);
    const toggled = await activity("instance.mcpToggled");
    expect(toggled.map((r) => r.data)).toEqual([
      { enabled: "true" },
      { enabled: "false" },
    ]);
  });
});
