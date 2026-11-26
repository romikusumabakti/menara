import { eq, sql } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { assertStrongSession, requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type EnvironmentStorage,
  environmentStorage,
  type SafeEnvironmentStorage,
} from "@/lib/db/schema";
import { drainLegacyConnections } from "@/lib/environment-storage";
import { environmentName } from "@/lib/environments";
import { testS3Connection } from "@/lib/explorer/s3";
import { overlapsBackupDestination } from "@/lib/restricted-targets";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  type EnvironmentStorageInput,
  normalizeKeyPrefix,
} from "@/lib/validation";
import { badRequest, CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";
import {
  changesS3Location,
  SECRET_REQUIRED_FOR_LOCATION_CHANGE,
} from "@/server/services/s3-connections";

// An environment's one object storage (environment_storage, 1:1; row present
// = configured). Viewing it takes what viewing the environment takes
// (project `project:read`); saving, removing and testing take what editing
// its settings takes (project `environment:update`, as updateEnvironment)
// plus a strong sign-in, since they store or use bucket credentials. An
// environment the caller can't see is a 404. The secret is never returned
// (toSafe) and never logged, and a stored secret is only ever used with the
// location it was given for (changesS3Location): pointing the storage at
// another endpoint, region, bucket, prefix, access key or addressing style
// takes a new secret. No config is saved or probed inside the instance
// backup destination (409 s3BackupDestinationOverlap); one that became
// restricted later (an admin moved the destination onto it) can still be
// removed or replaced by one outside it. Every save and remove also drains
// the environment's old s3_connections rows (lib/environment-storage).

const VIEW = { project: ["read"] } as const;
const MANAGE = { environment: ["update"] } as const;

async function requireManage(environmentId: string) {
  const access = await requireProjectPermission({ environmentId }, MANAGE);
  assertStrongSession(access.session);
  return access;
}

async function nameOf(environmentId: string): Promise<string> {
  return (await environmentName(environmentId)) ?? notFound();
}

async function refuseBackupDestinationOverlap(location: {
  endpoint: string;
  bucket: string;
  keyPrefix: string | null;
}): Promise<void> {
  if (!(await overlapsBackupDestination(location))) return;
  const t = await getServerTranslator("actionErrors");
  throw new CodedHTTPException(
    409,
    "s3BackupDestinationOverlap",
    t("s3BackupDestinationOverlap")
  );
}

async function secretRequiredForLocationChange(): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  badRequest(
    t(SECRET_REQUIRED_FOR_LOCATION_CHANGE),
    SECRET_REQUIRED_FOR_LOCATION_CHANGE
  );
}

// The stored form of a typed prefix, or the coded 400.
async function keyPrefixOf(
  input: string | null | undefined
): Promise<string | null> {
  const normalised = normalizeKeyPrefix(input);
  if (normalised.ok) return normalised.prefix;
  const t = await getServerTranslator("actionErrors");
  badRequest(t("s3KeyPrefixInvalid"), "s3KeyPrefixInvalid");
}

// The location fields, in changesS3Location's order (activity lists them so).
const LOCATION_FIELDS = [
  "endpoint",
  "region",
  "bucket",
  "keyPrefix",
  "accessKeyId",
  "forcePathStyle",
] as const;

type Location = Pick<EnvironmentStorage, (typeof LOCATION_FIELDS)[number]>;

async function locationOf(input: EnvironmentStorageInput): Promise<Location> {
  return {
    endpoint: input.endpoint.trim(),
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    keyPrefix: await keyPrefixOf(input.keyPrefix),
    accessKeyId: input.accessKeyId.trim(),
    forcePathStyle: input.forcePathStyle,
  };
}

function toSafe(
  row: EnvironmentStorage,
  restricted: boolean
): SafeEnvironmentStorage {
  const { secretKey, ...rest } = row;
  return {
    ...rest,
    hasSecret: secretKey.length > 0,
    isBackupDestination: restricted,
  };
}

async function toSafeChecked(
  row: EnvironmentStorage
): Promise<SafeEnvironmentStorage> {
  return toSafe(row, await overlapsBackupDestination(row));
}

export async function getEnvironmentStorage(
  environmentId: string
): Promise<SafeEnvironmentStorage | null> {
  await requireProjectPermission({ environmentId }, VIEW);
  const [row] = await db
    .select()
    .from(environmentStorage)
    .where(eq(environmentStorage.environmentId, environmentId))
    .limit(1);
  return row ? toSafeChecked(row) : null;
}

/**
 * Creates or replaces the environment's storage. A blank or omitted secret
 * keeps the stored one, which is allowed only when the location is
 * unchanged (else, and for a first save, the coded 400
 * s3SecretRequiredForLocationChange). Activity `storage.configured` lists
 * the changed field names, never their values.
 */
export async function saveEnvironmentStorage(
  environmentId: string,
  input: EnvironmentStorageInput
): Promise<SafeEnvironmentStorage> {
  const { session } = await requireManage(environmentId);
  const location = await locationOf(input);
  await refuseBackupDestinationOverlap(location);
  const environment = await nameOf(environmentId);
  const secretKey = input.secretKey || undefined;

  const { saved, fields } = await db.transaction(async (tx) => {
    // Locked, so the secret-reuse check holds for the row that is replaced.
    const [stored] = await tx
      .select()
      .from(environmentStorage)
      .where(eq(environmentStorage.environmentId, environmentId))
      .for("update");
    if (!secretKey && (!stored || changesS3Location(stored, location))) {
      await secretRequiredForLocationChange();
    }
    const changed: string[] = LOCATION_FIELDS.filter(
      (field) => !stored || stored[field] !== location[field]
    );
    if (secretKey) changed.push("secretKey");
    const secretPatch = secretKey
      ? { secretKey: encryptSecret(secretKey) }
      : {};
    const row = one(
      await tx
        .insert(environmentStorage)
        .values({
          environmentId,
          ...location,
          // A first save always has one (refused above otherwise).
          secretKey: secretPatch.secretKey ?? "",
        })
        .onConflictDoUpdate({
          target: environmentStorage.environmentId,
          set: { ...location, ...secretPatch, updatedAt: sql`now()` },
        })
        .returning(),
      "environment storage"
    );
    await drainLegacyConnections(tx, environmentId);
    return { saved: row, fields: changed };
  });

  await recordActivity({
    actorId: session.user.id,
    action: "storage.configured",
    entityType: "environment",
    entityId: environmentId,
    data: { environment, fields: fields.join(", ") },
  });
  // Never restricted: the overlap check above refused those.
  return toSafe(saved, false);
}

/**
 * Removes the environment's storage. Always allowed to its managers, also
 * for a config that has become restricted: removing exposes nothing.
 */
export async function removeEnvironmentStorage(
  environmentId: string
): Promise<void> {
  const { session } = await requireManage(environmentId);
  const environment = await nameOf(environmentId);
  const removed = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(environmentStorage)
      .where(eq(environmentStorage.environmentId, environmentId))
      .returning({ environmentId: environmentStorage.environmentId });
    await drainLegacyConnections(tx, environmentId);
    return rows.length > 0;
  });
  if (!removed) return;
  await recordActivity({
    actorId: session.user.id,
    action: "storage.removed",
    entityType: "environment",
    entityId: environmentId,
    data: { environment },
  });
}

export type EnvironmentStorageTestResult =
  | { ok: true }
  // No secret typed and none stored to fall back on.
  | { ok: false; code: "s3SecretRequiredForTest" }
  // The S3 client's own error, the probe's answer (e.g. "NoSuchBucket").
  | { ok: false; code: "s3ProbeFailed"; message: string };

/**
 * Probes form values without saving them, listing under the prefix as the
 * explorer will. Without a typed secret the stored one is used, but only
 * with its stored location (else the coded 400). Values inside the backup
 * destination are never probed (409).
 */
export async function testEnvironmentStorage(
  environmentId: string,
  input: EnvironmentStorageInput
): Promise<EnvironmentStorageTestResult> {
  await requireManage(environmentId);
  const location = await locationOf(input);
  await refuseBackupDestinationOverlap(location);
  let secretKey = input.secretKey || undefined;
  if (!secretKey) {
    const [stored] = await db
      .select()
      .from(environmentStorage)
      .where(eq(environmentStorage.environmentId, environmentId))
      .limit(1);
    if (!stored) return { ok: false, code: "s3SecretRequiredForTest" as const };
    if (changesS3Location(stored, location)) {
      await secretRequiredForLocationChange();
    }
    secretKey = decryptSecret(stored.secretKey);
  }
  const result = await testS3Connection({ ...location, secretKey });
  return result.ok
    ? result
    : { ok: false, code: "s3ProbeFailed" as const, message: result.message };
}
