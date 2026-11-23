import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Menara as an OAuth 2.1 authorization server for MCP clients (better-auth's
// jwt + mcp + cimd plugins, lib/auth.ts): the discovery documents, the
// instance switch, the CSRF exemption for the token endpoint, the loopback
// redirects native agent clients use, and DPoP being refused cleanly.
//
// The real app runs through `app.request`. better-auth's tables live in its
// in-memory adapter instead of Postgres; Menara's own tables (the MCP switch
// in instance_settings) come from a stubbed `db`, as in branding-api.test.ts.
// An agent's client metadata document comes from the stubbed CIMD fetcher.

const state = vi.hoisted(() => ({
  mcpEnabled: true,
  documents: new Map<string, unknown>(),
  // better-auth's models, by name, for its in-memory adapter.
  store: Object.fromEntries(
    [
      "user",
      "session",
      "account",
      "verification",
      "passkey",
      "twoFactor",
      "jwks",
      "oauthClient",
      "oauthResource",
      "oauthClientResource",
      "oauthRefreshToken",
      "oauthAccessToken",
      "oauthConsent",
      "oauthClientAssertion",
    ].map((model) => [model, [] as unknown[]])
  ),
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const selectFrom = (table: unknown) => {
    const rows = async () =>
      table === schema.instanceSettings ? [{ enabled: state.mcpEnabled }] : [];
    const query = {
      innerJoin: () => query,
      where: () => query,
      limit: () => query,
      // biome-ignore lint/suspicious/noThenProperty: a drizzle query is thenable.
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        rows().then(resolve, reject),
    };
    return query;
  };
  return { db: { select: () => ({ from: selectFrom }) }, pgClient: vi.fn() };
});

vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(state.store) };
});

vi.mock("@/lib/mcp/cimd-fetch", () => ({
  fetchClientMetadataSafely: vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    const document = state.documents.get(url);
    if (!document) return new Response("not found", { status: 404 });
    return Response.json(document);
  }),
}));

vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");
const { mountStatic } = await import("@/server/static");
const { invalidateMcpEnabled, MCP_RESOURCE } = await import("@/lib/mcp/config");

const BASE = new URL(process.env.BETTER_AUTH_URL || "http://localhost").origin;
const ISSUER = `${BASE}/api/auth`;

// The shape of a native agent client's metadata document, under a neutral
// URL: loopback redirects with no port, a public client.
const AGENT_ID = "https://agent.example.com/oauth/client-metadata";
const AGENT_DOCUMENT = {
  client_id: AGENT_ID,
  client_name: "Acme Agent",
  client_uri: "https://agent.example.com",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const PRM_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
];
const AS_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
  "/api/auth/.well-known/oauth-authorization-server",
];

let staticDir: string;

beforeAll(async () => {
  challenge = await codeChallenge();
  // The production SPA fallback, so a /.well-known miss is shown not to
  // reach it.
  staticDir = mkdtempSync(join(tmpdir(), "menara-mcp-static-"));
  const clientDir = join(staticDir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<!doctype html><html></html>");
  vi.stubEnv("NODE_ENV", "production");
  try {
    mountStatic(app, { clientDir, publicDir: join(staticDir, "public") });
  } finally {
    vi.unstubAllEnvs();
  }
});

afterAll(() => {
  rmSync(staticDir, { recursive: true, force: true });
});

beforeEach(() => {
  state.mcpEnabled = true;
  invalidateMcpEnabled();
  state.documents = new Map([[AGENT_ID, AGENT_DOCUMENT]]);
});

async function json(path: string) {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
  return (await res.json()) as Record<string, unknown>;
}

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const buffer =
    typeof bytes === "string"
      ? Buffer.from(bytes)
      : Buffer.from(bytes as ArrayBuffer);
  return buffer.toString("base64url");
}

let challenge = "";

function authorizeUrl(redirectUri: string): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: AGENT_ID,
    redirect_uri: redirectUri,
    scope: "read",
    state: "s-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
  });
  return `/api/auth/oauth2/authorize?${query}`;
}

describe("MCP authorization server", () => {
  it("serves protected resource metadata at both paths", async () => {
    const as = await json("/.well-known/oauth-authorization-server/api/auth");
    for (const path of PRM_PATHS) {
      const body = await json(path);
      expect(body.resource).toBe(MCP_RESOURCE);
      expect((body.authorization_servers as string[])[0]).toBe(as.issuer);
      expect(body.scopes_supported).toEqual([
        "read",
        "database:read",
        "issues:write",
        "deploys:write",
      ]);
      expect(body).not.toHaveProperty("dpop_signing_alg_values_supported");
      const head = await app.request(path, { method: "HEAD" });
      expect(head.status, `HEAD ${path}`).toBe(200);
      expect(head.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("serves authorization server metadata at root and path-inserted URLs", async () => {
    const [first, ...rest] = await Promise.all(AS_PATHS.map(json));
    for (const other of rest) expect(other).toEqual(first);
    expect(first?.issuer).toBe(ISSUER);
    expect(first?.client_id_metadata_document_supported).toBe(true);
    expect(first?.token_endpoint_auth_methods_supported).toContain("none");
    expect(first?.code_challenge_methods_supported).toEqual(["S256"]);
    expect(first?.authorization_response_iss_parameter_supported).toBe(true);
    expect(first).not.toHaveProperty("registration_endpoint");
    expect(first).not.toHaveProperty("dpop_signing_alg_values_supported");
    expect(first?.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("returns 404 for every MCP metadata document while instance_settings.mcp_enabled is false", async () => {
    state.mcpEnabled = false;
    invalidateMcpEnabled();
    for (const path of [...PRM_PATHS, ...AS_PATHS]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
    const authorize = await app.request(
      authorizeUrl("http://localhost:53124/callback")
    );
    expect(authorize.status).toBe(404);
    const token = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=x",
    });
    expect(token.status).toBe(404);
  });

  it("does not hand /.well-known paths to the SPA", async () => {
    const res = await app.request("/.well-known/unknown");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("lets a cross-origin form POST reach the token endpoint", async () => {
    const res = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://agent.example",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "not-a-code",
        client_id: AGENT_ID,
        redirect_uri: "http://localhost:53124/callback",
        code_verifier: "v".repeat(43),
        resource: MCP_RESOURCE,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "invalid_grant"
    );
  });

  it("still refuses a cross-origin form POST elsewhere", async () => {
    const res = await app.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example",
      },
      body: "accept=true",
    });
    expect(res.status).toBe(403);
  });

  it("accepts a native agent client's loopback redirects on any port", async () => {
    for (const redirect of [
      "http://localhost:53124/callback",
      "http://127.0.0.1:61000/callback",
    ]) {
      const res = await app.request(authorizeUrl(redirect));
      expect(res.status, redirect).toBe(302);
      const location = new URL(res.headers.get("location") ?? "", BASE);
      expect(location.origin, redirect).toBe(BASE);
      expect(["/sign-in", "/oauth/consent"], redirect).toContain(
        location.pathname
      );
    }
    const evil = await app.request(
      authorizeUrl("http://localhost.evil.example/callback")
    );
    const location = evil.headers.get("location") ?? "";
    expect(location).not.toContain("evil.example");
    expect(location).not.toContain("/sign-in");
    expect(location).not.toContain("/oauth/consent");
  });

  it("lets no signed-in user register an OAuth client by hand", async () => {
    const cookie = await signIn();
    const res = await app.request("/api/auth/oauth2/create-client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: BASE,
        Cookie: cookie,
      },
      body: JSON.stringify({
        client_name: "Acme Tool",
        redirect_uris: ["https://tool.example.com/callback"],
      }),
    });
    expect(res.status).toBe(401);
    expect(
      (state.store.oauthClient as { name?: string }[]).map((c) => c.name)
    ).not.toContain("Acme Tool");
  });

  it("closes better-auth's consent-management endpoints", async () => {
    // Grants are listed and revoked by lib/mcp/grants (which also revokes
    // the tokens and logs it); these would bypass all of that.
    const cookie = await signIn();
    const calls: [string, string][] = [
      ["GET", "/api/auth/oauth2/get-consents"],
      ["GET", "/api/auth/oauth2/get-consent?id=x"],
      ["POST", "/api/auth/oauth2/update-consent"],
      ["POST", "/api/auth/oauth2/delete-consent"],
    ];
    for (const [method, path] of calls) {
      const res = await app.request(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: BASE,
          Cookie: cookie,
        },
        ...(method === "POST" && {
          body: JSON.stringify({ id: "x", update: { scopes: ["read"] } }),
        }),
      });
      expect(res.status, path).toBe(404);
    }
  });

  it("issues tokens over the full code flow and refuses DPoP with a 400, not a 500", async () => {
    const cookie = await signIn();
    const redirectUri = "http://127.0.0.1:61000/callback";

    // Signed in: authorize goes straight to the consent page.
    const authorize = await app.request(authorizeUrl(redirectUri), {
      headers: { Cookie: cookie },
    });
    expect(authorize.status).toBe(302);
    const consentPage = new URL(authorize.headers.get("location") ?? "", BASE);
    expect(consentPage.pathname).toBe("/oauth/consent");

    const consent = await app.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: BASE,
        Cookie: cookie,
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentPage.search.slice(1),
      }),
    });
    expect(consent.status).toBe(200);
    const callback = new URL(((await consent.json()) as { url: string }).url);
    expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri);
    expect(callback.searchParams.get("iss")).toBe(ISSUER);
    const code = callback.searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    const tokenRequest = (params: Record<string, string>, dpop?: string) =>
      app.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(dpop ? { DPoP: dpop } : {}),
        },
        body: new URLSearchParams({
          client_id: AGENT_ID,
          resource: MCP_RESOURCE,
          ...params,
        }).toString(),
      });
    const codeGrant = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: CODE_VERIFIER,
    };

    // A DPoP proof is refused before the code is spent...
    const refused = await tokenRequest(codeGrant, await dpopProof());
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error?: string }).error).toBe(
      "invalid_dpop_proof"
    );

    // ...so the same code still redeems for a plain bearer token.
    const issued = await tokenRequest(codeGrant);
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as {
      token_type: string;
      access_token: string;
      refresh_token?: string;
      scope: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("read");
    const claims = JSON.parse(
      Buffer.from(
        tokens.access_token.split(".")[1] ?? "",
        "base64url"
      ).toString()
    ) as Record<string, unknown>;
    expect(claims.aud).toBe(MCP_RESOURCE);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.azp).toBe(AGENT_ID);

    // The MCP endpoint verifies this real token against the in-process keys
    // (signature, issuer, audience): it gets as far as the grant lookup,
    // which the stubbed db answers with no consent row.
    const mcp = await app.request(MCP_RESOURCE, {
      method: "POST",
      headers: {
        Host: new URL(MCP_RESOURCE).host,
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain(
      'error_description="the grant is no longer active"'
    );
  });
});

const CODE_VERIFIER = "acme-verifier-".padEnd(64, "x");

async function codeChallenge(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(CODE_VERIFIER)
  );
  return base64url(digest);
}

// A user who may sign in with a password, straight into better-auth's store.
async function signIn(): Promise<string> {
  const { hashPassword } = await import("better-auth/crypto");
  const now = new Date();
  const userId = "0190a000-0000-7000-8000-000000000001";
  const email = "ada@example.com";
  if (!state.store.user?.length) {
    state.store.user?.push({
      id: userId,
      email,
      name: "Ada",
      emailVerified: true,
      role: "admin",
      banned: false,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
    state.store.account?.push({
      id: "0190a000-0000-7000-8000-000000000002",
      userId,
      accountId: userId,
      providerId: "credential",
      password: await hashPassword("correct horse battery"),
      createdAt: now,
      updatedAt: now,
    });
  }
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

// An RFC 9449 proof for the token endpoint, signed with a fresh P-256 key.
async function dpopProof(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    "jwk",
    keys.publicKey
  );
  const header = base64url(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } })
  );
  const payload = base64url(
    JSON.stringify({
      jti: crypto.randomUUID(),
      htm: "POST",
      htu: `${ISSUER}/oauth2/token`,
      iat: Math.floor(Date.now() / 1000),
    })
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64url(signature)}`;
}
