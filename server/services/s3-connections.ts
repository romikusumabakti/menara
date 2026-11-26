import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-session";
import { ForbiddenError, requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  environments,
  projects,
  type S3Connection,
  type SafeS3Connection,
  s3Connections,
} from "@/lib/db/schema";
import { restrictedConnectionCheck } from "@/lib/restricted-targets";
import { notFound } from "@/server/errors";

// S3 connection helpers shared across environments: where an old
// /storage/<id> link leads (getS3ConnectionLocation) and the location and
// safe-projection helpers. An environment's own connections are managed
// through server/services/environment-storage, the only place a connection is
// created, edited or probed. `secretKey` is stripped before any row reaches
// the client.

type S3Location = Pick<
  S3Connection,
  | "endpoint"
  | "region"
  | "bucket"
  | "keyPrefix"
  | "accessKeyId"
  | "forcePathStyle"
>;
const LOCATION_FIELDS = [
  "endpoint",
  "region",
  "bucket",
  "keyPrefix",
  "accessKeyId",
  "forcePathStyle",
] as const satisfies readonly (keyof S3Location)[];

/**
 * Whether `next` points a connection anywhere its stored secret was not given
 * for: another endpoint, region, bucket, key prefix, access key or addressing
 * style (an omitted field is unchanged). Such a change, saved or probed, must
 * bring its own secret; otherwise whoever may edit the connection could aim
 * the stored credentials at another bucket, another prefix of the same one,
 * or a host of their own.
 */
export function changesS3Location(
  stored: S3Location,
  next: Partial<S3Location>
): boolean {
  return LOCATION_FIELDS.some(
    (field) => next[field] !== undefined && next[field] !== stored[field]
  );
}

/** The code (and actionErrors key) of that refusal. */
export const SECRET_REQUIRED_FOR_LOCATION_CHANGE =
  "s3SecretRequiredForLocationChange";

/**
 * The client-safe projection of a connection row: no secret.
 * `isBackupDestination` is whether the connection is a restricted target
 * (lib/restricted-targets#restrictedConnectionCheck: the legacy backup
 * destination connection, or one reaching into the backup destination), so
 * the pages hide Edit, Browse, Assign and Delete for it.
 */
export function toSafeS3Connection(
  row: S3Connection,
  restricted: boolean
): SafeS3Connection {
  const { secretKey, ...rest } = row;
  return {
    ...rest,
    hasSecret: secretKey.length > 0,
    isBackupDestination: restricted,
  };
}

/** Many rows, with the restricted check loaded once. */
export async function toSafeS3Connections(
  rows: S3Connection[]
): Promise<SafeS3Connection[]> {
  const isRestricted = await restrictedConnectionCheck();
  return rows.map((row) => toSafeS3Connection(row, isRestricted(row)));
}

/** Where an old /storage/<id> link leads (see getS3ConnectionLocation). */
export type S3ConnectionLocation = {
  kind: "environment";
  projectKey: string;
  envSlug: string;
};

/**
 * Where a connection's storage lives, for the removed /storage/<id> URLs: its
 * environment (project key and slug) when the caller may view that
 * environment (project:read). Everything else, an unassigned or missing
 * connection included, is the same 404, so the answer reveals nothing of
 * connections the caller can't reach.
 */
export async function getS3ConnectionLocation(
  id: string
): Promise<S3ConnectionLocation> {
  await requireSession();
  const [row] = await db
    .select({
      environmentId: s3Connections.environmentId,
      envSlug: environments.slug,
      projectKey: projects.key,
    })
    .from(s3Connections)
    .leftJoin(environments, eq(environments.id, s3Connections.environmentId))
    .leftJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(s3Connections.id, id))
    .limit(1);
  if (!row?.environmentId) notFound();
  try {
    await requireProjectPermission(
      { environmentId: row.environmentId },
      { project: ["read"] }
    );
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
  if (!row.projectKey || !row.envSlug) notFound();
  return {
    kind: "environment",
    projectKey: row.projectKey,
    envSlug: row.envSlug,
  };
}
