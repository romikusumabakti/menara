import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

// The whole MCP path against a real Postgres, the real better-auth instance
// (lib/auth.ts: jwt + mcp + cimd) and the real app: an agent registers by
// its client metadata document, a signed-in user approves part of what it
// asks for, the agent redeems the code with PKCE, lists and calls tools,
// rotates its refresh token, and loses everything once the grant is revoked.
// Same setup as issue-writes-scratch.test.ts: the local menara-postgres
// container, a scratch database migrated with `menara migrate` and dropped
// afterwards. Only the CIMD transport (no network), the job queue and Valkey
// (REDIS_URL empty: the quota fails open) are stand-ins.
//
//   MCP_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/mcp-flow-scratch.test.ts
const enabled = process.env.MCP_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "mcp_flow_scratch";

const CLIENT_ID = "https://client.example/cimd.json";
const CLIENT_NAME = "Acme Agent";
const CIMD_DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: CLIENT_NAME,
  client_uri: "https://client.example",
  redirect_uris: ["http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

vi.mock("@/lib/mcp/cimd-fetch", () => ({
  fetchClientMetadataSafely: vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CLIENT_ID) return new Response("not found", { status: 404 });
    return Response.json(CIMD_DOCUMENT);
  }),
}));
vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue")>()),
  enqueue: async () => {},
}));

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

const ADMIN = "00000000-0000-7000-8000-00000000f001";
const EMAIL = "admin@example.com";
const PASSWORD = "correct horse battery";
// The document lists the port-less loopback redirect; any port is accepted.
const REDIRECT_URI = "http://127.0.0.1:8976/callback";

type Tokens = {
  access_token: string;
  refresh_token?: string;
  scope: string;
  token_type: string;
};

describe.skipIf(!enabled)("MCP OAuth flow on Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let d: ReturnType<typeof drizzle>;
  let previousUrl: string | undefined;
  let app: typeof import("@/server/app")["app"];
  let config: typeof import("@/lib/mcp/config");
  let grants: typeof import("@/lib/mcp/grants");
  let base = "";
  let host = "";

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
    // No Valkey: the MCP quota fails open.
    vi.stubEnv("REDIS_URL", "");
    client = postgres(url, {
      max: 1,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    d = drizzle({ client });

    const { hashPassword } = await import("better-auth/crypto");
    await d.insert(schema.users).values({
      id: ADMIN,
      name: "Admin",
      email: EMAIL,
      emailVerified: true,
      role: "admin",
    });
    await d.insert(schema.accounts).values({
      id: "00000000-0000-7000-8000-00000000f002",
      userId: ADMIN,
      accountId: ADMIN,
      providerId: "credential",
      password: await hashPassword(PASSWORD),
    });
    await d.insert(schema.projects).values({ name: "Acme", key: "ACME" });
    await d
      .update(schema.instanceSettings)
      .set({ mcpEnabled: true })
      .where(eq(schema.instanceSettings.id, 1));

    ({ app } = await import("@/server/app"));
    config = await import("@/lib/mcp/config");
    grants = await import("@/lib/mcp/grants");
    config.invalidateMcpEnabled();
    base = new URL(config.MCP_RESOURCE).origin;
    host = new URL(config.MCP_RESOURCE).host;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  async function signIn(): Promise<string> {
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  /**
   * Authorize with PKCE (S256) and the MCP resource, approving `granted` of
   * `requested` when the consent page is shown. Returns the code and verifier.
   */
  async function authorize(cookie: string, requested: string, granted: string) {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(8).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: requested,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: config.MCP_RESOURCE,
    });
    const res = await app.request(`/api/auth/oauth2/authorize?${query}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(302);
    let callback = new URL(res.headers.get("location") ?? "", base);
    if (callback.origin === base) {
      expect(callback.pathname).toBe("/oauth/consent");
      const consent = await app.request("/api/auth/oauth2/consent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
          Cookie: cookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: granted,
          oauth_query: callback.search.slice(1),
        }),
      });
      expect(consent.status).toBe(200);
      callback = new URL(((await consent.json()) as { url: string }).url);
    }
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    return { code, verifier };
  }

  const tokenRequest = (params: Record<string, string>) =>
    app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        resource: config.MCP_RESOURCE,
        ...params,
      }).toString(),
    });

  async function redeem(code: string, verifier: string): Promise<Tokens> {
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Tokens;
  }

  const refresh = (refreshToken: string) =>
    tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

  async function refusedRefresh(refreshToken: string) {
    const res = await refresh(refreshToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "invalid_grant"
    );
  }

  /** The SDK client (2026-07-28), talking to the app in process. */
  async function connect(bearer: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(config.MCP_RESOURCE),
      {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("host", host);
          headers.set("authorization", `Bearer ${bearer}`);
          return app.request(String(input), { ...init, headers });
        },
      }
    );
    const mcp = new Client(
      { name: "acme-agent", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await mcp.connect(transport);
    return mcp;
  }

  async function toolNames(bearer: string): Promise<string[]> {
    const mcp = await connect(bearer);
    try {
      return (await mcp.listTools()).tools.map((t) => t.name);
    } finally {
      await mcp.close();
    }
  }

  /** A hand-written 2026-07-28 tools/call, as an agent sends it. */
  const rawCall = (bearer: string, name: string, args: unknown) =>
    app.request(config.MCP_RESOURCE, {
      method: "POST",
      headers: {
        host,
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "acme-agent",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

  const refreshRows = () =>
    d
      .select()
      .from(schema.oauthRefreshTokens)
      .where(
        and(
          eq(schema.oauthRefreshTokens.userId, ADMIN),
          eq(schema.oauthRefreshTokens.clientId, CLIENT_ID)
        )
      );

  it("completes authorize → consent → token → tools/list → tools/call → refresh → revoke", async () => {
    const cookie = await signIn();

    // 1–3. PKCE + resource; the user approves read and issues:write only.
    const { code, verifier } = await authorize(
      cookie,
      "offline_access read issues:write deploys:write",
      "offline_access read issues:write"
    );
    const [registered] = await d
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, CLIENT_ID));
    expect(registered?.name).toBe(CLIENT_NAME);
    const [consent] = await d
      .select()
      .from(schema.oauthConsents)
      .where(eq(schema.oauthConsents.clientId, CLIENT_ID));
    expect(consent?.scopes).toEqual(["offline_access", "read", "issues:write"]);

    const first = await redeem(code, verifier);
    expect(first.token_type).toBe("Bearer");
    expect(first.scope.split(" ").sort()).toEqual([
      "issues:write",
      "offline_access",
      "read",
    ]);
    expect(first.refresh_token).toBeTruthy();

    // 4. The granted scopes decide the tools.
    const names = await toolNames(first.access_token);
    expect(names).toContain("list_issues");
    expect(names).toContain("create_issue");
    expect(names).not.toContain("deploy");
    expect(names).not.toContain("rollback");

    // 5. A write through MCP names the client in its activity row.
    const mcp = await connect(first.access_token);
    try {
      const created = await mcp.callTool({
        name: "create_issue",
        arguments: { projectKey: "ACME", title: "Agent-filed issue" },
      });
      expect(created.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }
    const [issue] = await d
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.title, "Agent-filed issue"));
    expect(issue?.createdById).toBe(ADMIN);
    const rows = await d
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.entityId, issue?.id ?? ""));
    expect(rows.map((r) => [r.action, r.actorId])).toEqual([
      ["issue.created", ADMIN],
    ]);
    expect(rows[0]?.data).toMatchObject({
      viaClient: CLIENT_NAME,
      viaClientId: CLIENT_ID,
    });

    // 6. Refresh rotates: a new pair, and the old refresh token is spent.
    const rotated = await refresh(first.refresh_token ?? "");
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as Tokens;
    expect(second.refresh_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await toolNames(second.access_token)).toContain("create_issue");
    // Replaying the rotated token fails, and (reuse interval 0) revokes the
    // whole family: the token it was rotated into is dead too.
    await refusedRefresh(first.refresh_token ?? "");
    await refusedRefresh(second.refresh_token ?? "");

    // The consent stands, so a new authorize skips the consent page.
    const fresh = await authorize(
      cookie,
      "offline_access read issues:write",
      "offline_access read issues:write"
    );
    const third = await redeem(fresh.code, fresh.verifier);
    expect(third.refresh_token).toBeTruthy();
    expect(await toolNames(third.access_token)).toContain("list_issues");
    const live = (await refreshRows()).filter((r) => r.revoked === null);
    expect(live).toHaveLength(1);

    // 7. Revoke: the still-valid JWT and the unspent refresh token both stop.
    await grants.revokeGrant(ADMIN, ADMIN, CLIENT_ID);
    const denied = await rawCall(third.access_token, "list_issues", {});
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("invalid_token");
    // Revocation marks the refresh tokens revoked (a replay of one then
    // deletes the whole family, so look before replaying).
    const revokedRows = await refreshRows();
    expect(revokedRows.length).toBeGreaterThan(0);
    expect(revokedRows.every((r) => r.revoked !== null)).toBe(true);
    await refusedRefresh(third.refresh_token ?? "");

    // 8. Approving the agent again makes a new grant; the JWT of the revoked
    // one stays dead. The approval is stored at second precision, so step
    // past the second the old token was issued in.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await authorize(
      cookie,
      "offline_access read",
      "offline_access read"
    );
    const fourth = await redeem(again.code, again.verifier);
    const stale = await rawCall(third.access_token, "list_issues", {});
    expect(stale.status).toBe(401);
    expect(stale.headers.get("www-authenticate")).toContain("invalid_token");
    expect(await toolNames(fourth.access_token)).toContain("list_issues");
  });
});
