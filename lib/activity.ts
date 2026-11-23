import { db } from "@/lib/db";
import { activityLog } from "@/lib/db/schema";

// Append one event to the org-wide activity feed. Best-effort: a logging failure
// must never break the mutation that triggered it, so errors are swallowed after
// a console warning. `data` is denormalized display params for the i18n template
// keyed by `action` (see the /activity page renderer).
export async function recordActivity(input: {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  data: Record<string, string | number>;
}): Promise<void> {
  try {
    await db.insert(activityLog).values({
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      data: input.data,
    });
  } catch (error) {
    console.error("recordActivity failed:", error);
  }
}

// The OAuth client a write came through (an MCP tool call). Its activity row
// adds the flat keys `viaClient` (name) and `viaClientId`, and the feed
// appends "via {client}". Callers spread it inline (`...(via && {...})`)
// rather than through a helper here: many tests mock this module wholesale.
export type WriteVia = { client: string; clientId: string };
