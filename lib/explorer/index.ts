import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { environmentStorage, servers } from "@/lib/db/schema";
import { environmentName } from "@/lib/environments";
import { decryptNullable, decryptSecret } from "@/lib/secrets";
import { sshTarget } from "@/lib/ssh-connect";
import { createS3Backend } from "./s3";
import { createSftpBackend } from "./sftp";
import type { StorageBackend } from "./types";

export type { ExplorerEntry, StorageBackend } from "./types";

// A storage location the explorer browses. Carries only ids — credentials are
// loaded server-side here so they never live in a client payload or job record
// (same discipline as JobMap in lib/queue.ts). An S3 source is an
// environment's one object storage (environment_storage).
export type ExplorerSource =
  | { kind: "s3"; environmentId: string }
  | { kind: "sftp"; serverId: string };

// Resolve a source to a live backend, loading and injecting credentials from
// the DB. Returns null when the environment has no storage or the server no
// longer exists.
// This is the ONLY place credentials are read for the explorer.
export async function resolveBackend(
  source: ExplorerSource,
  // The signed-in user, recorded if an SFTP connection pins the host key.
  actorId?: string
): Promise<StorageBackend | null> {
  if (source.kind === "s3") {
    const [storage] = await db
      .select()
      .from(environmentStorage)
      .where(eq(environmentStorage.environmentId, source.environmentId))
      .limit(1);
    if (!storage) return null;
    return createS3Backend({
      ...storage,
      secretKey: decryptSecret(storage.secretKey),
    });
  }

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, source.serverId))
    .limit(1);
  if (!server) return null;
  return createSftpBackend(
    sshTarget({ ...server, password: decryptNullable(server.password) }),
    server.sftpRoot,
    { actor: actorId }
  );
}

// The display name of a source's server or environment, for the activity log.
// A separate cheap lookup (no credential load) run after an action succeeded.
export async function targetName(source: ExplorerSource): Promise<string> {
  if (source.kind === "s3") {
    return (await environmentName(source.environmentId)) ?? "";
  }
  const [server] = await db
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, source.serverId))
    .limit(1);
  return server?.name ?? "";
}
