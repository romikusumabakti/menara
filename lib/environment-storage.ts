import { eq } from "drizzle-orm";
import type { DbTransaction } from "@/lib/db";
import { s3Connections } from "@/lib/db/schema";

// environment_storage is authoritative; s3_connections only remains until the
// contract release. Whenever this build saves or removes an environment's
// storage, or deletes the environment, that environment's old connection
// rows go in the same transaction: no orphaned secrets appear (their FK is
// ON DELETE SET NULL, so an environment delete must drain first), and a
// rolled-back old build never shows a stale config for an environment this
// build has touched.

/** Deletes the environment's s3_connections rows, inside `tx`. */
export async function drainLegacyConnections(
  tx: DbTransaction,
  environmentId: string
): Promise<void> {
  await tx
    .delete(s3Connections)
    .where(eq(s3Connections.environmentId, environmentId));
}
