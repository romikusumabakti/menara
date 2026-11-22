import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { MotifSlug } from "@/lib/motifs";
import { AVATAR_FILE, SESSION_ID } from "./paths";

/**
 * The README screenshots, each in the light and the dark theme, written to
 * docs/images/<name>-<theme>.png, each on its own background motif (the
 * README's top three: Kawung, Megamendung, Pucuk Rebung), as the seeded demo-admin (signed in once
 * by sign-in.screenshots.ts). Only opens pages: nothing is created or sent.
 */

type Shot = {
  name: string;
  path: string;
  /** The background motif (lib/motifs.ts), one per shot. */
  motif: MotifSlug;
  /** Runs before the page loads (route stubs). */
  prepare?: (page: Page) => Promise<void>;
  /** Waits until the page shows its real content, not a skeleton. */
  ready: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
  {
    name: "home",
    motif: "pucuk-rebung",
    path: "/en",
    ready: (page) =>
      expect(
        page.getByRole("main").getByText("Demo Membership").first()
      ).toBeVisible(),
  },
  {
    name: "projects",
    motif: "kawung",
    path: "/en/projects",
    ready: (page) =>
      expect(
        page.getByRole("main").getByText("Demo Portal").first()
      ).toBeVisible(),
  },
  {
    name: "assistant",
    motif: "ukiran-asmat",
    path: "/en/assistant",
    ready: async (page) => {
      await page
        .getByText("Why does the member import reject empty rows?")
        .first()
        .click();
      await expect(
        page.getByText("MemberRowValidator.validate").first()
      ).toBeVisible();
      // The thread opens scrolled to its end; show it from the question.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("main *")) {
          if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = 0;
        }
      });
    },
  },
  {
    name: "knowledge",
    motif: "patra-punggel",
    path: "/en/knowledge/demo-alur-rilis-ke-qa",
    ready: (page) =>
      expect(page.getByRole("main").getByRole("heading").first()).toBeVisible(),
  },
  {
    name: "issues",
    motif: "batang-garing",
    path: "/en/issues",
    ready: (page) =>
      expect(
        page.getByRole("table", { name: "Issues" }).getByRole("link").first()
      ).toBeVisible(),
  },
  {
    name: "mock-time",
    motif: "megamendung",
    path: "/en/DEMO/qa/mock-time",
    // The demo environments run nothing and their servers are unreachable,
    // so this one shot stubs two responses: the environment gains a backend
    // with a clock API, and that clock reads frozen at New Year. The page
    // itself is the real UI.
    prepare: async (page) => {
      await page.route(
        "**/api/environments/get-environment-by-id?*",
        async (route) => {
          const response = await route.fetch();
          const environment = await response.json();
          environment.services = [
            ...(environment.services ?? []),
            {
              id: "00000000-0000-7000-8000-000000000001",
              environmentId: environment.id,
              role: "backend",
              mockTimeApiUrl: "https://demo-qa.example.invalid/api/clock",
            },
          ];
          await route.fulfill({ response, json: environment });
        }
      );
      await page.route("**/api/mock-time/get-clock-state?*", (route) =>
        route.fulfill({
          json: {
            success: true,
            data: {
              now: "2026-12-31T23:55:00.000Z",
              mocked: true,
              frozen: true,
            },
          },
        })
      );
    },
    ready: (page) =>
      expect(page.getByRole("main").getByRole("heading").first()).toBeVisible(),
  },
];

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test.beforeEach(async ({ page }) => {
      // The screenshot server has no object storage: answer the avatar URL
      // setup.ts stored with the local file.
      await page.route("**/api/avatars/**", (route) =>
        route.fulfill({ path: AVATAR_FILE, contentType: "image/jpeg" })
      );
      // Opening an environment would reorder Home's "Jump back in" between
      // the light and the dark run; keep the order setup.ts wrote.
      await page.route(
        "**/api/environments/record-environment-access",
        (route) => route.fulfill({ json: { success: true } })
      );
      const sessionId = readFileSync(SESSION_ID, "utf8");
      await page.addInitScript((id) => {
        sessionStorage.setItem(`strong-sign-in-dismissed:${id}`, "1");
      }, sessionId);
    });

    for (const shot of SHOTS) {
      test(shot.name, async ({ page, baseURL }) => {
        const motif = await page.request.post("/api/profile/set-motif", {
          data: { input: shot.motif },
          headers: { Origin: baseURL ?? "" },
        });
        expect(motif.ok()).toBe(true);
        await shot.prepare?.(page);
        await page.goto(shot.path);
        await shot.ready(page);
        // Let entrance motion and late images settle.
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(600);
        await page.screenshot({
          path: `docs/images/${shot.name}-${theme}.png`,
          animations: "disabled",
          caret: "hide",
        });
      });
    }
  });
}
