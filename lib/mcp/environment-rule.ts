import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { type environmentKindEnum, environments } from "@/lib/db/schema";
import { CodedHTTPException } from "@/server/errors";

// Where an agent may change what runs: deploy and rollback over MCP are
// allowed only on environments whose kind says they are disposable. Release
// environments behave like client UAT and are as read-only for agents as
// prod and demo; an unclassified environment is read-only too (fail closed).

export type EnvironmentKind = (typeof environmentKindEnum.enumValues)[number];

const AGENT_WRITABLE_KINDS: ReadonlySet<EnvironmentKind> = new Set([
  "dev",
  "qa",
  "sandbox",
]);

/** Whether an agent may deploy to or roll back an environment of `kind`. */
export function agentMayWrite(kind: EnvironmentKind | null): boolean {
  return kind !== null && AGENT_WRITABLE_KINDS.has(kind);
}

/**
 * Throws 409 `mcpEnvironmentReadOnly` (params `{ kind }`, "unset" for no
 * kind) unless agents may write to the environment. A missing environment
 * counts as unset.
 */
export async function assertAgentWritableEnvironment(
  environmentId: string
): Promise<void> {
  const [row] = await db
    .select({ kind: environments.kind })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  const kind = row?.kind ?? null;
  if (agentMayWrite(kind)) return;
  throw new CodedHTTPException(
    409,
    "mcpEnvironmentReadOnly",
    "Agents may deploy and roll back only on dev, qa and sandbox environments. Use the web UI for this one.",
    { kind: kind ?? "unset" }
  );
}
