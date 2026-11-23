import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { instanceSettings } from "@/lib/db/schema";

const BASE_URL = (
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

/**
 * The MCP server's canonical URL: the RFC 8707 resource every agent names in
 * its authorize and token requests, the `aud` of every MCP access token, and
 * the `resource` of the protected resource metadata.
 */
export const MCP_RESOURCE = `${BASE_URL}/api/mcp`;

// The scope list and the consent path live in a dependency-free module the
// consent page imports too.
export { MCP_CONSENT_PATH, MCP_SCOPES, type McpScope } from "./scopes";

/** How long a read of the instance switch is reused. */
const MCP_ENABLED_TTL_MS = 5_000;

let cached: { value: boolean; at: number } | null = null;
let inflight: Promise<boolean> | null = null;
let generation = 0;

async function loadMcpEnabled(): Promise<boolean> {
  const [row] = await db
    .select({ enabled: instanceSettings.mcpEnabled })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return row?.enabled === true;
}

/**
 * Whether an admin has turned the MCP server on (instance_settings
 * .mcp_enabled). Cached for 5 s, so a switch-off reaches every request within
 * that. A failed read answers false: the MCP surface fails closed.
 */
export async function isMcpEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.at < MCP_ENABLED_TTL_MS) {
    return cached.value;
  }
  if (inflight) return inflight;
  // A read that started before invalidateMcpEnabled() must not refill the
  // cache with the value from before the write.
  const started = generation;
  const promise = loadMcpEnabled()
    .catch((error: unknown) => {
      console.error("Failed to read the MCP switch:", error);
      return false;
    })
    .then((value) => {
      if (started === generation) cached = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  inflight = promise;
  return promise;
}

/** Drop the cached switch, so the next read sees a write at once. */
export function invalidateMcpEnabled(): void {
  generation += 1;
  cached = null;
  inflight = null;
}
