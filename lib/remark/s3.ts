import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  environmentArchives,
  instanceBackups,
  instanceSettings,
} from "@/lib/db/schema";
import {
  instanceName,
  legacyBackupPrefix,
  pgBackupLock,
  REMOTE_PREFIX,
} from "@/lib/instance-backup/archive";
import {
  type BackupDestination,
  destinationFromSettings,
  loadS3ConnectionStore,
  type ObjectStore,
} from "@/lib/instance-backup/destination";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";
import {
  ENV_ARCHIVE_PREFIX,
  legacyArchivePrefix,
} from "@/lib/teardown/archive";
import { sameS3Bucket } from "@/lib/validation";

// Step s3: the instance backups and environment archives an install on the
// previous name wrote, under `<legacy>-backups/<old instance>/` and
// `<legacy>-env-archives/<old instance>/`, move to `menara-backups/<instance>/`
// and `menara-env-archives/<instance>/` with the same relative keys:
// - in the backup destination (both kinds, under its key prefix);
// - in each S3 connection an older environment archive row names.
// One item per backup or archive folder. Apply copies every object of the
// folder server side, verifies each copy, then points the rows that hold the
// folder's key (instance_backups.object_key, environment_archives.key_prefix)
// at the new one, and only then deletes the old objects. A failed copy or
// verification keeps every old object and the rows as they were; copies
// already made are reused by the next run once they verify.
//
// Verification: same size, and same MD5 of the bytes. A plain ETag (32 hex)
// is the MD5 of an object S3 stored in one part, and CopyObject writes a
// plain one. A multipart ETag (`<hex>-<parts>`) is not a content hash and
// differs between a source and its copy even when the bytes are the same, so
// for such an object the MD5 is computed by reading it. That reads the large
// (multipart) sources once more, which a one-time migration can afford; a
// plain ETag that is not an MD5 (SSE-KMS on AWS) fails the check, never
// passes it.

type Kind = "backup" | "archive";

type CopyStore = Required<Pick<ObjectStore, "head" | "copy">> & ObjectStore;

type Place = {
  target: string;
  store: ObjectStore;
  /** What the store puts before its keys in the bucket (archive rows hold it). */
  lead: string;
  destination: BackupDestination | null;
  connectionId: string | null;
};

const DESTINATION = "s3/backup-destination";
const connectionTarget = (id: string) => `s3/connections/${id}`;

/** [old root, new root] of each kind. */
function roots(l: Legacy): Record<Kind, [string, string]> {
  const instance = instanceName();
  return {
    backup: [legacyBackupPrefix(l), `${REMOTE_PREFIX}${instance}/`],
    archive: [legacyArchivePrefix(l), `${ENV_ARCHIVE_PREFIX}${instance}/`],
  };
}

/** The kind and new key of an old key, or null when it is not under an old root. */
function mapped(l: Legacy, key: string): { kind: Kind; to: string } | null {
  for (const [kind, [from, to]] of Object.entries(roots(l)) as [
    Kind,
    [string, string],
  ][]) {
    if (key.startsWith(from) && key.length > from.length) {
      return { kind, to: `${to}${key.slice(from.length)}` };
    }
  }
  return null;
}

/** The folders (`<root><name>/`) of `keys` under `root`; a loose key stands alone. */
function folders(keys: string[], root: string): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(root) || key === root) continue;
    const rest = key.slice(root.length);
    const slash = rest.indexOf("/");
    out.add(slash === -1 ? key : `${root}${rest.slice(0, slash + 1)}`);
  }
  return [...out];
}

async function destinationPlace(ctx: RemarkContext): Promise<Place | null> {
  const [row] = await ctx.db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  const destination = row ? destinationFromSettings(row) : null;
  if (!destination) return null;
  return {
    target: DESTINATION,
    store: destination.store,
    lead: destination.keyPrefix ?? "",
    destination,
    connectionId: null,
  };
}

async function connectionPlace(id: string): Promise<Place> {
  const store = await loadS3ConnectionStore(id);
  if (!store) throw new Error("the S3 connection is gone");
  return {
    target: connectionTarget(id),
    store,
    lead: "",
    destination: null,
    connectionId: id,
  };
}

/** The S3 connections older legacy archive rows were written to. */
async function legacyConnections(ctx: RemarkContext): Promise<string[]> {
  const root = legacyArchivePrefix(ctx.legacy);
  const rows = await ctx.db.select().from(environmentArchives);
  return [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.location === "s3" &&
            r.s3ConnectionId !== null &&
            r.keyPrefix.startsWith(root)
        )
        .map((r) => r.s3ConnectionId as string)
    ),
  ];
}

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const l = ctx.legacy;
  const items: RemarkItem[] = [];
  const add = async (place: Place, kinds: Kind[]) => {
    for (const kind of kinds) {
      const [root] = roots(l)[kind];
      const keys = (await place.store.list(root)).map((o) => o.key);
      for (const from of folders(keys, root)) {
        const to = mapped(l, from)?.to;
        if (to) items.push({ step: "s3", target: place.target, from, to });
      }
    }
  };
  try {
    const place = await destinationPlace(ctx);
    if (place) await add(place, ["backup", "archive"]);
  } catch (error) {
    ctx.log.error(DESTINATION, messageOf(error));
  }
  for (const id of await legacyConnections(ctx)) {
    try {
      await add(await connectionPlace(id), ["archive"]);
    } catch (error) {
      ctx.log.error(connectionTarget(id), messageOf(error));
    }
  }
  return items;
}

const PLAIN_ETAG = /^"?([0-9a-f]{32})"?$/i;

/** The MD5 of an object's bytes: its plain ETag, else read and hashed. */
async function md5Of(
  store: ObjectStore,
  key: string,
  etag: string
): Promise<string> {
  const plain = PLAIN_ETAG.exec(etag)?.[1];
  if (plain) return plain.toLowerCase();
  const hash = createHash("md5");
  for await (const chunk of await store.read(key)) hash.update(chunk);
  return hash.digest("hex");
}

/** Copies `from` to `to` unless a copy is there, and proves it is the same object. */
async function copyVerified(
  store: Required<Pick<ObjectStore, "head" | "copy">> & ObjectStore,
  from: string,
  to: string
): Promise<void> {
  const source = await store.head(from);
  if (!source) throw new Error("the object is gone");
  let copy = await store.head(to);
  if (!copy) {
    await store.copy(from, to, source);
    copy = await store.head(to);
    if (!copy) throw new Error("the copy is not there");
  }
  if (copy.size !== source.size) {
    throw new Error(
      `the copy's size differs (${copy.size}, not ${source.size} bytes)`
    );
  }
  const [a, b] = [
    await md5Of(store, from, source.etag),
    await md5Of(store, to, copy.etag),
  ];
  if (a !== b) throw new Error("the copy's content differs");
}

/** Points the rows holding the folder's old key at the new one. */
async function record(
  ctx: RemarkContext,
  place: Place,
  kind: Kind,
  item: RemarkItem
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    if (kind === "backup") {
      const rows = await tx.select().from(instanceBackups);
      for (const r of rows) {
        if (r.location === "s3" && r.objectKey === item.from) {
          await tx
            .update(instanceBackups)
            .set({ objectKey: item.to })
            .where(eq(instanceBackups.id, r.id));
        }
      }
      return;
    }
    const rows = await tx.select().from(environmentArchives);
    for (const r of rows) {
      const here = place.destination
        ? r.inBackupDestination &&
          r.s3Endpoint !== null &&
          r.s3Bucket !== null &&
          sameS3Bucket(place.destination, {
            endpoint: r.s3Endpoint,
            bucket: r.s3Bucket,
          })
        : r.s3ConnectionId === place.connectionId;
      if (
        here &&
        r.location === "s3" &&
        r.keyPrefix === `${place.lead}${item.from}`
      ) {
        await tx
          .update(environmentArchives)
          .set({ keyPrefix: `${place.lead}${item.to}` })
          .where(eq(environmentArchives.id, r.id));
      }
    }
  });
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const conn = /^s3\/connections\/([0-9a-f-]+)$/i.exec(item.target);
  const place =
    item.target === DESTINATION
      ? await destinationPlace(ctx)
      : conn?.[1]
        ? await connectionPlace(conn[1])
        : null;
  if (!place) throw new Error(`no such place: ${item.target}`);
  const map = mapped(ctx.legacy, item.from);
  if (!map || map.to !== item.to || (map.kind === "backup" && conn)) {
    throw new Error("the item's keys are not this instance's");
  }
  const { store } = place;
  if (!store.head || !store.copy) {
    throw new Error("the store cannot copy objects");
  }
  const s3 = store as CopyStore;
  // The instance backup lock: a backup (and its retention) never lists,
  // writes or prunes these folders while they move.
  const release = await pgBackupLock();
  if (!release) {
    throw new Error(
      "an instance backup is running; run remark --step s3 --apply again once it has finished"
    );
  }
  try {
    await move(ctx, place, map.kind, item, s3);
  } finally {
    // The reserved connection is given back either way; an unlock error must
    // not hide the move's own.
    await release().catch(() => undefined);
  }
}

async function move(
  ctx: RemarkContext,
  place: Place,
  kind: Kind,
  item: RemarkItem,
  s3: CopyStore
): Promise<void> {
  // A folder holds every key under it; a loose key only itself.
  const under = async (key: string) =>
    (await s3.list(key)).filter((o) => key.endsWith("/") || o.key === key);

  const objects = await under(item.from);
  if (objects.length === 0) {
    if ((await under(item.to)).length === 0) {
      throw new Error("no object is under the old or the new key");
    }
    // Moved by an earlier run; make sure the rows say so.
    await record(ctx, place, kind, item);
    return;
  }
  const failures: string[] = [];
  for (const o of objects) {
    try {
      await copyVerified(
        s3,
        o.key,
        `${item.to}${o.key.slice(item.from.length)}`
      );
    } catch (error) {
      failures.push(`${o.key}: ${messageOf(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${objects.length} object(s) not copied (${failures[0]}); the old objects are kept`
    );
  }
  await record(ctx, place, kind, item);
  try {
    await s3.delete(objects.map((o) => o.key));
  } catch (error) {
    throw new Error(
      `copied and recorded, but the old objects could not be deleted (${messageOf(error)}); run remark again to delete them`
    );
  }
}
