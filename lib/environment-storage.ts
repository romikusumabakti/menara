import { and, eq, notExists } from "drizzle-orm";
import type { DbTransaction } from "@/lib/db";
import {
  environmentArchives,
  instanceSettings,
  s3Connections,
} from "@/lib/db/schema";

// environment_storage is authoritative; s3_connections only remains until the
// contract release. Whenever this build saves or removes an environment's
// storage, or deletes the environment (or its project), that environment's
// old connection rows go in the same transaction: no orphaned secrets appear
// (their FK is ON DELETE SET NULL, so an environment delete must drain
// first), and a rolled-back old build never shows a stale config for an
// environment this build has touched.
//
// A row legacy code still reads stays, detached (environment_id null, as the
// old FK did): one an `s3` archive names (its download and prune read it) or
// the superseded instance_settings.backup_destination_id. Same predicates as
// the one-per-environment migration's DELETE.

/**
 * Drains the environment's s3_connections rows, inside `tx`: deletes the
 * unreferenced ones, detaches the referenced ones.
 */
export async function drainLegacyConnections(
  tx: DbTransaction,
  environmentId: string
): Promise<void> {
  const archived = tx
    .select({ id: environmentArchives.id })
    .from(environmentArchives)
    .where(eq(environmentArchives.s3ConnectionId, s3Connections.id));
  const backup = tx
    .select({ id: instanceSettings.id })
    .from(instanceSettings)
    .where(eq(instanceSettings.backupDestinationId, s3Connections.id));
  await tx
    .delete(s3Connections)
    .where(
      and(
        eq(s3Connections.environmentId, environmentId),
        notExists(archived),
        notExists(backup)
      )
    );
  await tx
    .update(s3Connections)
    .set({ environmentId: null })
    .where(eq(s3Connections.environmentId, environmentId));
}
