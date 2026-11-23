import { expect, type Page, test } from "@playwright/test";
import {
  AUTH_FILE,
  mcpAuthorizeUrl,
  OAUTH_CALLBACK,
  seedPublicOAuthClient,
} from "./support";

// Connected apps end to end (Stage 11): an admin turns MCP on with the real
// switch in Admin › Instance › MCP, approves an agent on the consent page,
// finds it under Account › Connected apps, revokes it, and the row is gone.
// The activity feed records the approval and the revocation.

const CLIENT_NAME = "Acme Connector";
let clientId = "";

test.use({ storageState: AUTH_FILE });

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: baseURL ?? "" },
  ]);
});

test.beforeAll(async ({ baseURL }) => {
  clientId = await seedPublicOAuthClient(baseURL ?? "", CLIENT_NAME);
});

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

/** Flips the switch and waits for the server to take it. */
async function toggle(page: Page, to: boolean) {
  const sw = page.getByRole("switch", { name: "Allow MCP clients" });
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/instance/mcp") && r.request().method() === "PUT"
  );
  await sw.click();
  expect((await saved).status()).toBe(200);
  await expect(sw).toBeChecked({ checked: to });
}

test("approve, list and revoke a connected app", async ({ page, baseURL }) => {
  const origin = baseURL ?? "";

  // An earlier spec may have left MCP on: start from off, then turn it on.
  await page.goto("/en/admin/instance?tab=mcp");
  const sw = page.getByRole("switch", { name: "Allow MCP clients" });
  await expect(sw).toBeVisible();
  if (await sw.isChecked()) await toggle(page, false);
  await toggle(page, true);
  await expect(page.getByText(`${origin}/api/mcp`).first()).toBeVisible();

  // The agent's authorize request, approved on the consent page.
  const callback = catchCallback(page);
  const { url, state } = mcpAuthorizeUrl(
    origin,
    clientId,
    "offline_access read issues:write"
  );
  await page.goto(url);
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  const reached = await callback;
  expect(reached.searchParams.get("code")).toBeTruthy();
  expect(reached.searchParams.get("state")).toBe(state);
  // The callback handler would otherwise hold the next navigation.
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Account › Connected apps lists it, with its scopes and no use yet.
  await page.goto("/en/account?tab=connected-apps");
  const row = page.getByRole("listitem").filter({ hasText: CLIENT_NAME });
  await expect(row).toBeVisible();
  await expect(row.getByText("issues:write", { exact: true })).toBeVisible();
  await expect(row.getByText("Last used never")).toBeVisible();
  // The setup card is built from this instance's URL.
  await expect(
    page.getByText(
      new RegExp(`mcp add --transport http \\S+ ${origin}/api/mcp`)
    )
  ).toBeVisible();

  // Revoke, behind a confirmation.
  await row.getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByText(`Revoke access for ${CLIENT_NAME}?`)
  ).toBeVisible();
  await expect(dialog.getByText("It stops working at once.")).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: CLIENT_NAME })
  ).toHaveCount(0);

  // Both ends of the grant are in the activity feed.
  await page.goto("/en/admin/activity");
  await expect(
    page.getByText(
      new RegExp(`allowed ${CLIENT_NAME} to use their account over MCP`)
    )
  ).toBeVisible();
  await expect(
    page.getByText(new RegExp(`revoked the access of ${CLIENT_NAME} for`))
  ).toBeVisible();
  await expect(
    page.getByText(/allowed MCP clients on this instance/).first()
  ).toBeVisible();
});
