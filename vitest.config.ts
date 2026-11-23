import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Workers are fresh `bun` processes, which load the developer's .env on
    // their own; CI has none, so skipping it keeps local runs the same as CI.
    execArgv: ["--no-env-file"],
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // Loaded through Vitest rather than natively, so a test's vi.mock of
    // node:dns/promises and node:https reaches its Node transport
    // (tests/mcp-cimd-fetch.test.ts).
    server: { deps: { inline: ["@better-auth/cimd"] } },
  },
});
