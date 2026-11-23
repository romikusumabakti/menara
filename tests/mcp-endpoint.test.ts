import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  type CryptoKey,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@/lib/access-scope";

// The MCP endpoint (/api/mcp) on the production middleware stack: the bearer
// gate (lib/mcp/gate), the per-request viewer and the read tools
// (lib/mcp/read-tools). Tokens are signed with a test key that the faked
// better-auth instance serves as its in-process JWKS, so better-auth's own
// requireMcpAuth verifies them; Menara's tables come from a stubbed `db`; the
// data cores behind list_issues and get_service_logs are stubbed at their
// service modules, so the Assistant's tool code, scoping and filters run as
// they do in production.

const ISSUER = "https://app.example.net/api/auth";
const RESOURCE = "https://app.example.net/api/mcp";
const HOST = "app.example.net";
const CLIENT_ID = "https://agent.example.com/oauth/client.json";
const USER_ID = "01900000-0000-7000-8000-0000000000a1";
const ACME_ID = "01900000-0000-7000-8000-000000000001";
const BETA_ID = "01900000-0000-7000-8000-000000000002";
const ENV_ID = "01900000-0000-7000-8000-000000001001";

type Grant = { scopes: string[]; clientName: string | null; disabled: boolean };

const state = vi.hoisted(() => ({
  mcpEnabled: true,
  jwks: { keys: [] as unknown[] },
  grant: null as Grant | null,
  scope: null as AccessScope | null,
  banned: false,
  serviceLog: "",
  usageWrites: [] as unknown[],
  getSession: vi.fn(),
  reserveVerificationValue: vi.fn(),
}));

vi.mock("@/lib/auth", () => {
  const jwtPlugin = {
    id: "jwt",
    options: {},
    endpoints: { getJwks: async () => state.jwks },
  };
  // What requireMcpAuth reads from the auth instance: its base URL (the
  // issuer), the jwt plugin's in-process key source, and the adapter as the
  // key-cache key.
  const context = {
    baseURL: ISSUER,
    getPlugin: (id: string) => (id === "jwt" ? jwtPlugin : undefined),
    adapter: {},
    internalAdapter: {
      reserveVerificationValue: state.reserveVerificationValue,
    },
    options: {},
  };
  return {
    auth: {
      options: {},
      $context: Promise.resolve(context),
      api: { getSession: state.getSession },
    },
  };
});

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const rowsOf = (table: unknown): unknown[] => {
    if (table === schema.instanceSettings) {
      return [{ enabled: state.mcpEnabled }];
    }
    if (table === schema.oauthConsents) return state.grant ? [state.grant] : [];
    if (table === schema.users) return [{ timezone: null }];
    return [];
  };
  const selectFrom = (table: unknown) => {
    const query = {
      innerJoin: () => query,
      leftJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      // biome-ignore lint/suspicious/noThenProperty: a drizzle query is thenable.
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        Promise.resolve(rowsOf(table)).then(resolve, reject),
    };
    return query;
  };
  const insert = (table: unknown) => ({
    values: (values: unknown) => ({
      onConflictDoUpdate: async () => {
        if (table === schema.mcpGrantUsage) state.usageWrites.push(values);
      },
    }),
  });
  return {
    db: { select: () => ({ from: selectFrom }), insert },
    pgClient: vi.fn(),
  };
});

vi.mock("@/lib/assistant/viewer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/assistant/viewer")>();
  return {
    ...actual,
    loadAssistantViewer: vi.fn(async () => {
      if (state.banned || !state.scope) {
        throw new actual.AssistantViewerError("banned", "banned");
      }
      return actual.buildAssistantViewer(state.scope);
    }),
    loadProjectEntries: vi.fn(async () => [
      {
        id: ACME_ID,
        key: "ACME",
        name: "Acme",
        group: null,
        description: null,
      },
      {
        id: BETA_ID,
        key: "BETA",
        name: "Beta",
        group: null,
        description: null,
      },
    ]),
  };
});

// Issues of both projects; the core returns those the scope sees, as its SQL
// filter does.
vi.mock("@/server/services/issues", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/services/issues")>();
  const issue = (projectId: string, key: string) => ({
    id: `${key}-id`,
    number: 1,
    title: `${key} issue`,
    status: "todo",
    type: "bug",
    priority: "medium",
    jiraKey: null,
    assignee: null,
    environment: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    projectId,
    project: { key },
  });
  return {
    ...actual,
    listAllIssuesFor: vi.fn(
      async (scope: AccessScope, query: { projectId?: string }) => {
        const rows = [issue(ACME_ID, "ACME"), issue(BETA_ID, "BETA")].filter(
          (row) =>
            row.projectId in scope.projectRoles &&
            (!query.projectId || row.projectId === query.projectId)
        );
        return { rows, total: rows.length };
      }
    ),
  };
});

vi.mock("@/server/services/environments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/services/environments")>();
  return {
    ...actual,
    listEnvironmentsFor: vi.fn(async () => [
      {
        id: ENV_ID,
        projectId: ACME_ID,
        name: "QA",
        slug: "qa",
        kind: "qa",
        ownerId: null,
        url: null,
        appId: null,
        envFileManaged: false,
        entryPort: null,
        dbType: null,
        dbName: null,
        key: "ACME",
        hasMailpit: false,
        serviceRoles: ["backend"],
        projectReleasable: false,
        lastAccessedAt: null,
      },
    ]),
  };
});

vi.mock("@/server/services/services", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/services/services")>();
  return {
    ...actual,
    getServiceLogsFor: vi.fn(async () => ({
      found: true,
      output: state.serviceLog,
    })),
  };
});

// query_database's first step: never reached without database:read.
const queryGate = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/assistant-db/gate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/assistant-db/gate")>();
  return {
    ...actual,
    checkReadOnlyQuery: (
      ...args: Parameters<typeof actual.checkReadOnlyQuery>
    ) => {
      queryGate.calls += 1;
      return actual.checkReadOnlyQuery(...args);
    },
  };
});

const { createBaseApp } = await import("@/server/app");
const { mcpRouter } = await import("@/server/routes/mcp");
const { invalidateMcpEnabled } = await import("@/lib/mcp/config");
const { resetGrantUsageThrottle } = await import("@/lib/mcp/gate");
const { setRateLimitConnectionForTests } = await import("@/lib/mcp/rate-limit");

const app = createBaseApp().route("/api/mcp", mcpRouter);

let signingKey: CryptoKey;
const KID = "test-key";

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  state.jwks = { keys: [{ ...jwk, kid: KID, alg: "ES256", use: "sig" }] };
});

function scopeAs(
  orgRole: AccessScope["orgRole"],
  projectRoles: AccessScope["projectRoles"] = { [ACME_ID]: "engineer" }
): AccessScope {
  return { userId: USER_ID, orgRole, projectRoles, seesAllProjects: false };
}

beforeEach(() => {
  state.mcpEnabled = true;
  state.banned = false;
  state.scope = scopeAs("engineer");
  state.grant = {
    scopes: ["read", "database:read", "offline_access"],
    clientName: "Acme Agent",
    disabled: false,
  };
  state.serviceLog = "";
  state.usageWrites = [];
  state.getSession.mockReset();
  state.reserveVerificationValue.mockReset();
  queryGate.calls = 0;
  invalidateMcpEnabled();
  resetGrantUsageThrottle();
  // No Valkey here unless a test sets one: the limiter fails open.
  vi.stubEnv("REDIS_URL", "");
  setRateLimitConnectionForTests(undefined);
});

async function token(
  over: Record<string, unknown> = {},
  opts: { audience?: string; typ?: string } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    azp: CLIENT_ID,
    client_id: CLIENT_ID,
    scope: "read database:read offline_access",
    sid: "session-1",
    ...over,
  })
    .setProtectedHeader({ alg: "ES256", kid: KID, typ: opts.typ ?? "at+jwt" })
    .setSubject(USER_ID)
    .setIssuer(ISSUER)
    .setAudience(opts.audience ?? RESOURCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setJti(crypto.randomUUID())
    .sign(signingKey);
}

const LIST_TOOLS = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "acme-agent",
        version: "1",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

/** A hand-written 2026-07-28 request, as an agent sends it. */
function post(headers: Record<string, string>, body: unknown = LIST_TOOLS) {
  return app.request(RESOURCE, {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** The SDK client, talking to the app in process with `bearer`. */
async function connect(
  bearer: string,
  era: "modern" | "legacy" = "modern"
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", HOST);
      headers.set("authorization", `Bearer ${bearer}`);
      return app.request(String(input), { ...init, headers });
    },
  });
  const client = new Client(
    { name: "acme-test-agent", version: "1.0.0" },
    era === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : {}
  );
  await client.connect(transport);
  return client;
}

async function toolNames(bearer: string): Promise<string[]> {
  const client = await connect(bearer);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

/** A Valkey stand-in for the limiter; returns its counters by key. */
function useFakeValkey(): Map<string, number> {
  const counts = new Map<string, number>();
  setRateLimitConnectionForTests({
    multi: () => {
      let key = "";
      let by = 0;
      const chain = {
        incrby: (k: string, n: number) => {
          key = k;
          by = n;
          return chain;
        },
        expire: () => chain,
        exec: async () => {
          const next = (counts.get(key) ?? 0) + by;
          counts.set(key, next);
          return [
            [null, next],
            [null, 1],
          ] as [null, number][];
        },
      };
      return chain;
    },
  });
  return counts;
}

/** The counter of `kind` for the test user and client, summed over windows. */
function counted(counts: Map<string, number>, kind: "read" | "write"): number {
  let total = 0;
  for (const [key, value] of counts) {
    if (key.startsWith(`mcp:rl:${kind}:${USER_ID}:${CLIENT_ID}:`)) {
      total += value;
    }
  }
  return total;
}

const callBody = (name: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});

describe("MCP endpoint authentication", () => {
  it("401 with resource_metadata challenge and no token", async () => {
    const response = await post({});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://app.example.net/.well-known/oauth-protected-resource/api/mcp"'
    );
  });

  it("ignores a valid session cookie: no bearer, 401", async () => {
    state.getSession.mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "s1" },
    });
    const response = await post({
      cookie: "better-auth.session_token=signed-session-token",
    });
    expect(response.status).toBe(401);
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it("refuses a token for another audience", async () => {
    const bearer = await token(
      {},
      { audience: "https://other.example/api/mcp" }
    );
    const response = await post({ authorization: `Bearer ${bearer}` });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"'
    );
  });

  it("refuses a JWT that is not an access token (typ other than at+jwt)", async () => {
    for (const typ of ["JWT", "id_token+jwt"]) {
      const response = await post({
        authorization: `Bearer ${await token({}, { typ })}`,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        'error="invalid_token"'
      );
    }
    // The access-token type in its full media-type form is accepted.
    const full = await post({
      authorization: `Bearer ${await token({}, { typ: "application/at+jwt" })}`,
    });
    expect(full.status).toBe(200);
  });

  it("refuses a token without azp", async () => {
    const response = await post({
      authorization: `Bearer ${await token({ azp: undefined })}`,
    });
    expect(response.status).toBe(401);
  });

  it("413 JSON-RPC error for a body over 4 MiB", async () => {
    const bearer = await token();
    const big = { ...LIST_TOOLS, padding: "x".repeat(4 * 1024 * 1024) };
    const response = await post({ authorization: `Bearer ${bearer}` }, big);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
      id: null,
    });
    // Also without a Content-Length (chunked).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(big)));
        controller.close();
      },
    });
    const chunked = await app.request(RESOURCE, {
      method: "POST",
      headers: {
        host: HOST,
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body,
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it("429 with Retry-After over the per-minute quota", async () => {
    const counts = useFakeValkey();
    const bearer = await token();
    for (let i = 0; i < 120; i++) {
      const ok = await post({ authorization: `Bearer ${bearer}` });
      expect(ok.status).toBe(200);
    }
    const limited = await post({ authorization: `Bearer ${bearer}` });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await limited.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000, data: { code: "mcpRateLimited" } },
    });
    // Unauthenticated requests never count.
    expect([...counts.keys()].every((k) => k.startsWith("mcp:rl:read:"))).toBe(
      true
    );
  });

  it("counts a write call from the body, whatever Mcp-Name claims", async () => {
    const counts = useFakeValkey();
    const bearer = await token();
    // A 2025-era request (no protocol claims): the SDK never compares the
    // header with the body there.
    await app.request(RESOURCE, {
      method: "POST",
      headers: {
        host: HOST,
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-name": "list_issues",
      },
      body: JSON.stringify(callBody("deploy")),
    });
    expect(counted(counts, "write")).toBe(1);

    // The Base64 sentinel form of the header.
    await post(
      {
        authorization: `Bearer ${bearer}`,
        "mcp-method": "tools/call",
        "mcp-name": "=?base64?ZGVwbG95?=",
      },
      callBody("deploy")
    );
    expect(counted(counts, "write")).toBe(2);

    // A read call stays a read.
    await post(
      {
        authorization: `Bearer ${bearer}`,
        "mcp-method": "tools/call",
        "mcp-name": "list_issues",
      },
      callBody("list_issues")
    );
    expect(counted(counts, "write")).toBe(2);
    expect(counted(counts, "read")).toBe(1);
  });

  it("counts every write call of a legacy batch", async () => {
    const counts = useFakeValkey();
    const bearer = await token();
    const batch = (n: number) =>
      app.request(RESOURCE, {
        method: "POST",
        headers: {
          host: HOST,
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify([
          ...Array.from({ length: n }, (_, i) => callBody("deploy", i + 1)),
          callBody("list_issues", n + 1),
        ]),
      });
    await batch(3);
    expect(counted(counts, "write")).toBe(3);
    expect(counted(counts, "read")).toBe(0);
    // 3 + 18 = 21 > 20: the whole batch is refused.
    const limited = await batch(18);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("refuses a token signed with another key", async () => {
    const other = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ azp: CLIENT_ID, scope: "read" })
      .setProtectedHeader({ alg: "ES256", kid: KID, typ: "at+jwt" })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(other.privateKey);
    const response = await post({ authorization: `Bearer ${forged}` });
    expect(response.status).toBe(401);
  });

  it("403 insufficient_scope for a token without read", async () => {
    const bearer = await token({ scope: "database:read" });
    const response = await post({ authorization: `Bearer ${bearer}` });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"'
    );
  });

  it("404 while mcp_enabled is false", async () => {
    state.mcpEnabled = false;
    const response = await post({
      authorization: `Bearer ${await token()}`,
    });
    expect(response.status).toBe(404);
    const get = await app.request(RESOURCE, { headers: { host: HOST } });
    expect(get.status).toBe(404);
  });

  it("refuses a revoked grant with a still-valid JWT", async () => {
    const bearer = await token();
    expect(await toolNames(bearer)).toContain("list_issues");
    state.grant = null;
    const response = await post({ authorization: `Bearer ${bearer}` });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"'
    );
  });

  it("refuses a grant of a disabled client", async () => {
    state.grant = { ...(state.grant as Grant), disabled: true };
    const response = await post({ authorization: `Bearer ${await token()}` });
    expect(response.status).toBe(401);
  });

  it("refuses a banned user on the next call", async () => {
    const bearer = await token();
    expect(await toolNames(bearer)).toContain("list_issues");
    state.banned = true;
    const response = await post({ authorization: `Bearer ${bearer}` });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"'
    );
  });

  it("refuses DPoP cleanly and never touches the replay store", async () => {
    // A bearer token under the DPoP scheme.
    const bearer = await token();
    const asDpop = await post({
      authorization: `DPoP ${bearer}`,
      dpop: "not-a-proof",
    });
    expect(asDpop.status).toBe(401);

    // A DPoP-bound token with a well-formed proof: refused on the algorithm,
    // before any replay bookkeeping.
    const proofKey = await generateKeyPair("ES256");
    const jwk: JWK = await exportJWK(proofKey.publicKey);
    const bound = await token({
      cnf: { jkt: await calculateJwkThumbprint(jwk) },
    });
    const ath = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bound))
    ).toString("base64url");
    const proof = await new SignJWT({
      htm: "POST",
      htu: RESOURCE,
      ath,
      jti: crypto.randomUUID(),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(proofKey.privateKey);
    const withProof = await post({
      authorization: `DPoP ${bound}`,
      dpop: proof,
    });
    expect(withProof.status).toBe(401);
    const asBearer = await post({ authorization: `Bearer ${bound}` });
    expect(asBearer.status).toBe(401);
    expect(state.reserveVerificationValue).not.toHaveBeenCalled();
  });

  it("403 for a foreign Origin, 405 for GET", async () => {
    const bearer = await token();
    const foreign = await post({
      authorization: `Bearer ${bearer}`,
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    const sameSite = await post({
      authorization: `Bearer ${bearer}`,
      origin: "https://app.example.net",
    });
    expect(sameSite.status).toBe(200);
    const wrongHost = await post({
      authorization: `Bearer ${bearer}`,
      host: "attacker.example",
    });
    expect(wrongHost.status).toBe(403);
    const get = await app.request(RESOURCE, {
      headers: { host: HOST, authorization: `Bearer ${bearer}` },
    });
    expect(get.status).toBe(405);
    const del = await app.request(RESOURCE, {
      method: "DELETE",
      headers: { host: HOST, authorization: `Bearer ${bearer}` },
    });
    expect(del.status).toBe(405);
  });

  it("records the grant's last use at most once a minute", async () => {
    const bearer = await token();
    await post({ authorization: `Bearer ${bearer}` });
    await post({ authorization: `Bearer ${bearer}` });
    expect(state.usageWrites).toEqual([
      expect.objectContaining({ userId: USER_ID, clientId: CLIENT_ID }),
    ]);
  });
});

describe("MCP read tools", () => {
  it("lists read tools only for scope read", async () => {
    const names = await toolNames(await token({ scope: "read" }));
    expect(names).toContain("list_issues");
    expect(names).toContain("get_service_logs");
    expect(names).not.toContain("query_database");
    expect(names).not.toContain("list_tables");
    expect(names).not.toContain("read_attachment");
    expect(names).not.toContain("read_upload");
    for (const write of [
      "create_issue",
      "update_issue",
      "deploy",
      "rollback",
    ]) {
      expect(names).not.toContain(write);
    }
  });

  it("marks every tool read-only and closed-world", async () => {
    const client = await connect(await token());
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          openWorldHint: false,
        });
      }
    } finally {
      await client.close();
    }
  });

  it("adds list_tables/query_database with database:read for an engineer, not for qa", async () => {
    const bearer = await token();
    expect(await toolNames(bearer)).toEqual(
      expect.arrayContaining(["list_tables", "query_database"])
    );
    state.scope = scopeAs("qa", { [ACME_ID]: "qa" });
    const names = await toolNames(bearer);
    expect(names).toContain("list_issues");
    expect(names).not.toContain("query_database");
  });

  it("narrows the token's scopes to what the grant holds now", async () => {
    const bearer = await token();
    state.grant = { ...(state.grant as Grant), scopes: ["read"] };
    expect(await toolNames(bearer)).not.toContain("query_database");
  });

  it("a demotion takes effect on the next call", async () => {
    const bearer = await token();
    const before = await toolNames(bearer);
    expect(before).toContain("query_database");
    state.scope = scopeAs("qa", { [ACME_ID]: "qa" });
    const after = await toolNames(bearer);
    expect(after).not.toContain("query_database");
    expect(after.length).toBeLessThan(before.length);
  });

  it("scopes list_issues to the viewer's projects", async () => {
    state.scope = scopeAs("qa", { [ACME_ID]: "qa" });
    const client = await connect(await token({ scope: "read" }));
    try {
      const all = await client.callTool({ name: "list_issues", arguments: {} });
      expect(all.isError).toBeFalsy();
      const keys = (
        all.structuredContent as { issues: { key: string }[] }
      ).issues.map((i) => i.key);
      expect(keys).toEqual(["ACME-1"]);

      const beta = await client.callTool({
        name: "list_issues",
        arguments: { project: "BETA" },
      });
      expect(beta.isError).toBe(true);
      expect(JSON.stringify(beta.content)).not.toContain("BETA issue");
    } finally {
      await client.close();
    }
  });

  it("never returns a seeded secret", async () => {
    state.serviceLog =
      "2026-11-24 boot\nDB_URL=postgres://app:x@db/app password=hunter2\nready\n";
    const client = await connect(await token());
    try {
      const result = await client.callTool({
        name: "get_service_logs",
        arguments: { environment: "ACME/qa", role: "backend" },
      });
      expect(result.isError).toBeFalsy();
      const wire = JSON.stringify(result);
      expect(wire).not.toContain("hunter2");
      expect(wire).toContain("ready");
    } finally {
      await client.close();
    }
  });

  it("refuses query_database on a token without database:read, unexecuted", async () => {
    const client = await connect(await token({ scope: "read" }));
    try {
      const result = await client
        .callTool({
          name: "query_database",
          arguments: { environment: "ACME/qa", sql: "select 1" },
        })
        .catch((error: unknown) => ({ isError: true, thrown: String(error) }));
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(queryGate.calls).toBe(0);
  });

  it("logs neither the bearer token nor tool output", async () => {
    state.serviceLog =
      "2026-11-24 boot\nDB_URL=postgres://app:x@db/app password=hunter2\nready-marker-7\n";
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(
        args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")
      );
    };
    const info = vi.spyOn(console, "info").mockImplementation(capture);
    const error = vi.spyOn(console, "error").mockImplementation(capture);
    const bearer = await token();
    try {
      const client = await connect(bearer);
      try {
        const result = await client.callTool({
          name: "get_service_logs",
          arguments: { environment: "ACME/qa", role: "backend" },
        });
        expect(JSON.stringify(result)).toContain("ready-marker-7");
        await client.callTool({
          name: "list_issues",
          arguments: { project: "NOPE" },
        });
      } finally {
        await client.close();
      }
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
    const logged = lines.join("\n");
    expect(logged).toContain("tool=get_service_logs");
    expect(logged).not.toContain(bearer);
    expect(logged).not.toContain(bearer.split(".")[2]);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("ready-marker-7");
    expect(logged).not.toContain("ACME issue");
  });

  it("serves 2025-era clients through the stateless fallback", async () => {
    const client = await connect(await token(), "legacy");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("list_issues");
    } finally {
      await client.close();
    }
  });
});
