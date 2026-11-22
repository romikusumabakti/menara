import { readFileSync, writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { CREDENTIALS, SESSION_ID, STATE } from "./paths";

/**
 * Signs in once as the seeded demo-admin (password from setup.ts) and saves
 * the session for readme.screenshots.ts: better-auth rate-limits repeated
 * sign-ins.
 */

test("sign in as demo-admin", async ({ page }) => {
  const { email, password } = JSON.parse(readFileSync(CREDENTIALS, "utf8")) as {
    email: string;
    password: string;
  };
  await page.goto("/en/sign-in");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes("sign-in"));
  await page.context().storageState({ path: STATE });
  // The password-only session gets the strong sign-in banner on every page;
  // its dismissal lives in sessionStorage (not in the saved state), keyed by
  // the session id, so readme.screenshots.ts sets it before each page loads.
  const res = await page.request.get("/api/auth/get-session");
  const { session } = (await res.json()) as { session: { id: string } };
  writeFileSync(SESSION_ID, session.id);
});
