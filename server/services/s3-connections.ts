import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-session";
import { ForbiddenError, requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  environments,
  projects,
  type S3Connection,
  s3Connections,
} from "@/lib/db/schema";
import { notFound } from "@/server/errors";

// What remains of the s3_connections service until the contract release:
// where an old /storage/<id> link leads (getS3ConnectionLocation), and the
// stored-secret location rule (changesS3Location) that
// server/services/environment-storage applies to an environment's one
// storage. No connection row reaches the client.

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
