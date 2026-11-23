import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import {
  AUTH_FILE,
  enableMcp,
  mcpAuthorizeUrl,
  OAUTH_CALLBACK,
  seedPublicOAuthClient,
  submitCode,
  submitCredentials,
  totpCode,
} from "./support";

// The consent step of the MCP authorization flow (Stage 11): an agent opens
// the authorize URL, the signed-in user approves or denies on
// /<locale>/oauth/consent, and the browser goes back to the agent's loopback
// redirect. A signed-out user signs in first and must land on the consent
// page, not on `/`.

const CLIENT_NAME = "Acme Agent";
// The instance name in the title may be the branding spec's, so match any.
const CONSENT_TITLE = new RegExp(
  `^Allow ${CLIENT_NAME} to use your .+ account\\?$`
);
let clientId = "";

// The specs before this one may leave the stored session's locale cookie on
// another language; the copy checked here is English.
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: baseURL ?? "" },
  ]);
});

test.beforeAll(async ({ baseURL }) => {
  const origin = baseURL ?? "";
  await enableMcp(origin);
  clientId = await seedPublicOAuthClient(origin, CLIENT_NAME);
});

/**
 * The password step, retried once the sign-in rate limit (5 a minute, one
 * shared bucket on the e2e server) has reset: auth.spec.ts signs in several
 * times just before this spec when it runs alone.
 */
async function signInPastRateLimit(page: Page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = page.waitForResponse((r) =>
      r.url().endsWith("/api/auth/sign-in/email")
    );
    await submitCredentials(page, "Sign in");
    const response = await answer;
    if (response.status() !== 429) return;
    const wait = Number(response.headers()["x-retry-after"] ?? "60");
    await page.waitForTimeout((wait + 1) * 1000);
  }
  throw new Error("sign-in stayed rate-limited");
}

/** Catches the redirect to the agent's loopback server; nothing listens there. */
async function catchCallback(page: Page) {
  let resolve: (url: URL) => void = () => {};
  const reached = new Promise<URL>((r) => {
    resolve = r;
  });
  await page.route(`${new URL(OAUTH_CALLBACK).origin}/**`, async (route) => {
    resolve(new URL(route.request().url()));
    await route.fulfill({ status: 200, body: "callback" });
  });
  return reached;
}

test.describe("signed in", () => {
  test.use({ storageState: AUTH_FILE });

  test("approve returns a code to the client", async ({ page, baseURL }) => {
    const callback = catchCallback(page);
    const { url, state } = mcpAuthorizeUrl(
      baseURL ?? "",
      clientId,
      "offline_access read issues:write deploys:write"
    );
    await page.goto(url);

    await expect(page).toHaveURL(/\/en\/oauth\/consent\?.*sig=/);
    await expect(
      page.getByRole("heading", {
        name: CONSENT_TITLE,
      })
    ).toBeVisible();
    await expect(page.getByText("127.0.0.1")).toBeVisible();
    await expect(page.getByText("admin@example.com")).toBeVisible();
    // Untick one write scope: the grant carries only what stays ticked.
    await page
      .getByRole("checkbox", {
        name: "Deploy and roll back dev, QA and sandbox environments as you",
      })
      .click();
    await page.getByRole("button", { name: "Allow", exact: true }).click();

    const reached = await callback;
    expect(`${reached.origin}${reached.pathname}`).toBe(OAUTH_CALLBACK);
    expect(reached.searchParams.get("code")).toBeTruthy();
    expect(reached.searchParams.get("state")).toBe(state);
    expect(reached.searchParams.get("iss")).toBe(`${baseURL}/api/auth`);

    // The grant holds what stayed ticked, read and offline_access.
    const sql = postgres(process.env.DATABASE_URL ?? "", {
      max: 1,
      onnotice: () => {},
    });
    try {
      const rows = await sql<{ scopes: string[] }[]>`
        select scopes from oauth_consents where client_id = ${clientId}`;
      expect(rows.map((r) => r.scopes)).toEqual([
        ["offline_access", "read", "issues:write"],
      ]);
    } finally {
      await sql.end();
    }
  });

  test("deny returns access_denied", async ({ page, baseURL }) => {
    const callback = catchCallback(page);
    const { url, state } = mcpAuthorizeUrl(
      baseURL ?? "",
      clientId,
      "read database:read"
    );
    await page.goto(url);
    await expect(
      page.getByText("Query results are sent to the AI model this app uses.")
    ).toBeVisible();
    await page.getByRole("button", { name: "Deny", exact: true }).click();

    const reached = await callback;
    expect(`${reached.origin}${reached.pathname}`).toBe(OAUTH_CALLBACK);
    expect(reached.searchParams.get("error")).toBe("access_denied");
    expect(reached.searchParams.get("state")).toBe(state);
    expect(reached.searchParams.get("code")).toBeNull();
  });
});

test.describe("consent-info", () => {
  test.use({ storageState: AUTH_FILE });

  test("refuses a query the server did not sign", async ({ request }) => {
    const forged = new URLSearchParams({
      client_id: clientId,
      scope: "read deploys:write",
      exp: String(Math.floor(Date.now() / 1000) + 600),
      sig: "forged",
    });
    for (const name of ["client_id", "scope", "exp", "ba_param"]) {
      forged.append("ba_param", name);
    }
    const res = await request.get(`/api/oauth/consent-info?${forged}`);
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "oauthConsentInvalid"
    );
  });
});

test("a signed-out user lands on consent after signing in", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const { url } = mcpAuthorizeUrl(
      baseURL ?? "",
      clientId,
      // deploys:write was left out of the grant above, so consent is asked.
      "offline_access read deploys:write"
    );
    await page.goto(url);
    await expect(page).toHaveURL(/\/en\/sign-in\?.*sig=/);

    await signInPastRateLimit(page);
    await submitCode(page, await totpCode());

    await expect(page).toHaveURL(/\/en\/oauth\/consent\?.*sig=/);
    await expect(
      page.getByRole("heading", {
        name: CONSENT_TITLE,
      })
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
