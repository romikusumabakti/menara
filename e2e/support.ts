import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import type { Page } from "@playwright/test";
import postgres from "postgres";

export const ADMIN = {
  name: "E2E Admin",
  email: "admin@example.com",
  password: "e2e-Password-123",
};

/** Where auth.spec.ts leaves the signed-in admin's cookies for the other specs. */
export const AUTH_FILE = "e2e/.auth/admin.json";

/** The admin's authenticator secret, saved by auth.spec.ts when it turns TOTP on. */
export const TOTP_SECRET_FILE = "e2e/.auth/totp-secret";

/**
 * The code an authenticator app would show right now for the admin. The saved
 * secret is the Base32 text from the setup screen; an authenticator decodes it
 * to bytes before computing the code, so this does too.
 */
export async function totpCode() {
  const secret = readFileSync(TOTP_SECRET_FILE, "utf8").trim();
  return createOTP(base32.decode(secret)).totp();
}

/** First step of sign-in: email and password. Labels differ per locale, so address the inputs by type. */
export async function submitCredentials(page: Page, submitName: string) {
  await page.locator('input[type="email"]').fill(ADMIN.email);
  await page.locator('input[type="password"]').fill(ADMIN.password);
  await page.getByRole("button", { name: submitName, exact: true }).click();
}

// better-auth's two-factor plugin allows 3 verifications per client, and the
// counter only resets after 10 quiet seconds since the last one. The specs run
// from one address, so rather than loosen that limit the helpers below pace
// their own verifications.
const VERIFY_LIMIT = 3;
const VERIFY_WINDOW_MS = 10_500;
let verifyCount = 0;
let lastVerifyAt = 0;

/** Call right before a TOTP verification; waits if the rate limit would reject it. */
export async function paceTotpVerification() {
  if (Date.now() - lastVerifyAt >= VERIFY_WINDOW_MS) verifyCount = 0;
  if (verifyCount >= VERIFY_LIMIT) {
    const wait = lastVerifyAt + VERIFY_WINDOW_MS - Date.now();
    await new Promise((resolve) => setTimeout(resolve, wait));
    verifyCount = 0;
  }
  verifyCount += 1;
  lastVerifyAt = Date.now();
}

/** Second step of sign-in: the code field is the only one-time-code input on the page. */
export async function submitCode(page: Page, code: string) {
  await paceTotpVerification();
  const field = page.locator('input[autocomplete="one-time-code"]');
  await field.fill(code);
  await field.press("Enter");
}

/** Sign in through the form, including the authenticator code step. */
export async function signIn(page: Page, submitName: string) {
  await submitCredentials(page, submitName);
  await submitCode(page, await totpCode());
}

/**
 * Turn the MCP server on (instance_settings.mcp_enabled) straight in the e2e
 * database, then wait until the server sees it: it caches the switch for up to
 * 5 s, and the authorization server's metadata answers 404 while it is off.
 */
export async function enableMcp(baseURL: string) {
  const sql = postgres(process.env.DATABASE_URL ?? "", {
    max: 1,
    onnotice: () => {},
  });
  try {
    await sql`update instance_settings set mcp_enabled = true where id = 1`;
  } finally {
    await sql.end();
  }
  const metadata = `${baseURL}/.well-known/oauth-authorization-server/api/auth`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await fetch(metadata)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The MCP switch did not reach the server within 15 s");
}

/** The loopback redirect every seeded client registers; any port is accepted. */
export const OAUTH_CALLBACK = "http://127.0.0.1:8976/callback";

/**
 * A public (PKCE, no secret) OAuth client named `name`, redirecting to
 * OAUTH_CALLBACK. Returns its client_id.
 *
 * Written straight into the e2e database. The oauth-provider admin API
 * (`auth.api.adminCreateOAuthClient`) refuses it like every other client
 * write, because lib/auth.ts sets `clientPrivileges: () => false` and the
 * admin endpoint asks that hook too. Agents register only through CIMD,
 * which needs a public metadata URL, and the e2e server has none. So these
 * are the rows the admin endpoint would write: the client, plus its link to
 * the MCP resource.
 */
export async function seedPublicOAuthClient(baseURL: string, name: string) {
  const clientId = randomBytes(16).toString("base64url");
  const sql = postgres(process.env.DATABASE_URL ?? "", {
    max: 1,
    onnotice: () => {},
  });
  try {
    await sql`
      insert into oauth_clients
        (id, client_id, name, redirect_uris, token_endpoint_auth_method,
         application_type, grant_types, response_types, scopes, require_pkce,
         skip_consent, disabled, created_at, updated_at)
      values
        (${randomUUID()}, ${clientId}, ${name}, ${[OAUTH_CALLBACK]}, 'none',
         'native', ${["authorization_code", "refresh_token"]}, ${["code"]},
         ${["offline_access", "read", "database:read", "issues:write", "deploys:write"]},
         true, false, false, now(), now())`;
    await sql`
      insert into oauth_client_resources (id, client_id, resource_id, created_at)
      values (${randomUUID()}, ${clientId}, ${`${baseURL}/api/mcp`}, now())`;
  } finally {
    await sql.end();
  }
  return clientId;
}

/**
 * An authorize URL as an MCP agent opens it: PKCE (S256), the MCP resource,
 * a state. Returns the URL and the state to check on the callback.
 */
export function mcpAuthorizeUrl(
  baseURL: string,
  clientId: string,
  scope: string
) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: OAUTH_CALLBACK,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${baseURL}/api/mcp`,
  });
  return {
    url: `${baseURL}/api/auth/oauth2/authorize?${query}`,
    state,
  };
}
