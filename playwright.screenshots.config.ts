import { defineConfig, devices } from "@playwright/test";
import { STATE } from "./docs/screenshots/paths";
import base from "./playwright.config";

// The README screenshots (docs/screenshots/readme.screenshots.ts): the e2e
// server setup on a fresh *_e2e database, filled by docs/screenshots/setup.ts
// instead of the e2e specs. Run:
//
//   DATABASE_URL=postgres://…/menara_e2e bunx playwright test -c playwright.screenshots.config.ts
const webServer = Array.isArray(base.webServer)
  ? base.webServer[0]
  : base.webServer;
if (!webServer) throw new Error("playwright.config.ts has no webServer");

export default defineConfig({
  ...base,
  testDir: "./docs/screenshots",
  retries: 0,
  reporter: "list",
  projects: [
    {
      name: "sign-in",
      testMatch: "sign-in.screenshots.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "screenshots",
      testMatch: "readme.screenshots.ts",
      dependencies: ["sign-in"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        storageState: STATE,
      },
    },
  ],
  webServer: {
    ...webServer,
    command:
      "bun --no-env-file e2e/reset-db.ts && bun --no-env-file docs/screenshots/setup.ts && bun run build && bun run start",
    reuseExistingServer: false,
  },
});
