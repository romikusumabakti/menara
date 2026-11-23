import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

const NAME = "Acme Ops";

// Leave the instance as other specs expect it: unbranded, so the name reads
// "Menara" again.
test.afterAll(async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({
    baseURL,
    storageState: AUTH_FILE,
    // Hono's CSRF guard wants an app Origin on a body-less write.
    extraHTTPHeaders: { Origin: baseURL ?? "" },
  });
  try {
    const removed = await admin.delete(
      "/api/instance/branding/logo?theme=light"
    );
    expect(removed.ok()).toBe(true);
    const reset = await admin.put("/api/instance/branding", {
      data: { name: null, company: null, accent: null },
    });
    expect(reset.ok()).toBe(true);
  } finally {
    await admin.dispose();
  }
});

test("admin sets the name and uploads a logo; sign-in shows both", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/en/admin/instance");
  await page.getByRole("tab", { name: "Branding" }).click();

  await page.getByLabel("Instance name").fill(NAME);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Branding saved")).toBeVisible();

  const lightSlot = page.locator('[data-logo-theme="light"]');
  await lightSlot
    .locator('input[type="file"]')
    .setInputFiles("e2e/fixtures/logo.svg");
  await expect(page.getByText("Logo uploaded")).toBeVisible();
  await expect(lightSlot.locator('img[src^="/brand/logo"]')).toBeVisible();

  // A visitor with no session sees the new name and logo.
  // An empty storage state: the file's `test.use` session would otherwise
  // carry over, and the visitor would land in the app shell, not on sign-in.
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const visitor = await context.newPage();
    await visitor.goto("/en/sign-in");
    await expect(visitor.getByText(NAME).first()).toBeVisible();
    await expect(
      visitor.locator('img[src^="/brand/logo"]').first()
    ).toBeVisible();
    await expect(visitor).toHaveTitle(NAME);
    // The renamed instance still credits Menara, without its version.
    const powered = visitor.getByRole("link", { name: "Menara" });
    await expect(powered).toHaveAttribute(
      "href",
      "https://github.com/romikusumabakti/menara"
    );
    await expect(visitor.getByText("Powered by")).toBeVisible();
    await visitor.screenshot({ path: "test-results/sign-in-footer.png" });

    const logo = await context.request.get("/brand/logo");
    expect(logo.ok()).toBe(true);
    expect(logo.headers()["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
    expect(logo.headers()["x-content-type-options"]).toBe("nosniff");
  } finally {
    await context.close();
  }
});

test("About Menara names the product behind a renamed instance", async ({
  page,
}) => {
  await page.goto("/en");
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.getByRole("menuitem", { name: "About Menara" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Menara" })).toBeVisible();
  await expect(dialog.getByText(`${NAME} runs on Menara`)).toBeVisible();
  // The e2e build has no release version.
  await expect(dialog.getByText("Development build")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Source code" })
  ).toHaveAttribute("href", "https://github.com/romikusumabakti/menara");
  await expect(
    dialog.getByRole("link", { name: "Report an issue" })
  ).toHaveAttribute("href", "https://github.com/romikusumabakti/menara/issues");
  await dialog.screenshot({
    path: "test-results/about-dialog.png",
    animations: "disabled",
  });
});
