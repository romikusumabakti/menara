import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "@/lib/instance-backup/destination";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, fakeDrizzleOperators, type Row } from "./support/remark-db";

// The s3 step against in-memory buckets: the backup destination (confined to
// its key prefix, as the real one is) and one S3 connection an older
// environment archive was written to. A copy behaves like CopyObject: the
// new object's ETag is the MD5 of its bytes, whatever the source's was.

vi.mock("drizzle-orm", (orig) => fakeDrizzleOperators(orig));

type Obj = { body: Buffer; etag: string };

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

function bucket() {
  const objects = new Map<string, Obj>();
  const ops: string[] = [];
  const faults = {
    failCopy: new Set<string>(),
    corruptCopy: new Set<string>(),
    failDelete: false,
  };
  const store: ObjectStore = {
    async list(prefix) {
      ops.push(`list ${prefix}`);
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, size: o.body.length }));
    },
    download: async () => {
      throw new Error("not used");
    },
    async read(key) {
      ops.push(`read ${key}`);
      const o = objects.get(key);
      if (!o) throw new Error(`no ${key}`);
      return Readable.from([o.body]);
    },
    upload: async () => {
      throw new Error("not used");
    },
    async delete(keys) {
      ops.push(`delete ${keys.join(",")}`);
      if (faults.failDelete) throw new Error("DeleteObjects failed");
      for (const k of keys) objects.delete(k);
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.body.length, etag: `"${o.etag}"` } : null;
    },
    async copy(from, to, source) {
      ops.push(`copy ${from} -> ${to}`);
      const o = objects.get(from);
      if (faults.failCopy.has(from)) throw new Error("CopyObject failed");
      if (!o || `"${o.etag}"` !== source.etag) {
        throw new Error("PreconditionFailed");
      }
      const body = faults.corruptCopy.has(from)
        ? Buffer.from(o.body.toString().toUpperCase())
        : o.body;
      objects.set(to, { body, etag: md5(body) });
    },
  };
  /** A single-part object (`multipart` false) or a multipart one. */
  const put = (key: string, text: string, multipart = false) => {
    const body = Buffer.from(text);
    objects.set(key, {
      body,
      etag: multipart ? `${md5(Buffer.from(`parts:${text}`))}-2` : md5(body),
    });
  };
  return { objects, ops, faults, store, put };
}

const state = vi.hoisted(() => ({
  destination: null as unknown,
  connections: new Map<string, unknown>(),
}));

vi.mock("@/lib/instance-backup/destination", async (orig) => ({
  ...(await orig<typeof import("@/lib/instance-backup/destination")>()),
  destinationFromSettings: () => state.destination,
  loadS3ConnectionStore: async (id: string) =>
    state.connections.get(id) ?? null,
}));

const { prefixedStore } = await import("@/lib/instance-backup/destination");
const step = await import("@/lib/remark/s3");

const LEGACY: Legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};

const CONN = "0197f3a0-1b2c-7def-8000-00000000c001";
const B1 = "0197f3a0-1b2c-7def-8000-00000000b001";
const A1 = "0197f3a0-1b2c-7def-8000-00000000a001";
const A2 = "0197f3a0-1b2c-7def-8000-00000000a002";
const NAME = "2026-11-01T020000.000Z-a1b2c3-0.5.25";

const OLD_BACKUP = `oldtool-backups/oldtool-beta/${NAME}/`;
const NEW_BACKUP = `menara-backups/beta/${NAME}/`;
const OLD_ARCHIVE = `oldtool-env-archives/oldtool-beta/${A1}/`;
const NEW_ARCHIVE = `menara-env-archives/beta/${A1}/`;
const OLD_CONN_ARCHIVE = `oldtool-env-archives/oldtool-beta/${A2}/`;
const NEW_CONN_ARCHIVE = `menara-env-archives/beta/${A2}/`;

let dest: ReturnType<typeof bucket>;
let conn: ReturnType<typeof bucket>;
let tables: Record<string, Row[]>;
let errors: { target: string; message: string }[];

function ctx(): RemarkContext {
  return {
    legacy: LEGACY,
    db: fakeDb(tables),
    log: {
      info: () => {},
      error: (target, message) => errors.push({ target, message }),
    },
  };
}

function seedLegacy() {
  dest.put(`acme/${OLD_BACKUP}database.dump`, "dump-bytes", true);
  dest.put(`acme/${OLD_BACKUP}manifest.json`, '{"format":1}');
  dest.put(`acme/${OLD_ARCHIVE}database.sql.gz`, "archive-bytes", true);
  conn.put(`${OLD_CONN_ARCHIVE}deploy-dir.tar.gz`, "tar-bytes");
}

/** What is already Menara's, or another instance's. */
function seedOthers() {
  dest.put(
    "acme/menara-backups/beta/2026-11-20T020000.000Z-d4e5f6-0.6.0/manifest.json",
    "{}"
  );
  dest.put("acme/oldtool-backups/oldtool-prod/x/manifest.json", "{}");
  dest.put("acme/menara-env-archives/beta/z/f", "f");
  conn.put("oldtool-env-archives/oldtool-prod/q/f", "f");
}

beforeEach(() => {
  vi.stubEnv("COMPOSE_PROJECT_NAME", "beta");
  dest = bucket();
  conn = bucket();
  state.destination = {
    endpoint: "https://objects.example.test",
    bucket: "fictional-backups",
    keyPrefix: "acme/",
    store: prefixedStore(dest.store, "acme/"),
    bucketStore: dest.store,
    keepDaily: 14,
    keepWeekly: 8,
  };
  state.connections = new Map([[CONN, conn.store]]);
  errors = [];
  tables = {
    instance_settings: [{ id: 1 }],
    instance_backups: [
      { id: B1, location: "s3", objectKey: OLD_BACKUP, status: "succeeded" },
      {
        id: "0197f3a0-1b2c-7def-8000-00000000b002",
        location: "local",
        objectKey: `oldtool-beta/${NAME}/`,
        status: "succeeded",
      },
    ],
    environment_archives: [
      {
        id: A1,
        location: "s3",
        inBackupDestination: true,
        s3Endpoint: "https://objects.example.test",
        s3Bucket: "fictional-backups",
        s3ConnectionId: null,
        keyPrefix: `acme/${OLD_ARCHIVE}`,
      },
      {
        id: A2,
        location: "s3",
        inBackupDestination: false,
        s3Endpoint: null,
        s3Bucket: null,
        s3ConnectionId: CONN,
        keyPrefix: OLD_CONN_ARCHIVE,
      },
    ],
  };
});
afterEach(() => vi.unstubAllEnvs());

const legacyKeys = (b: ReturnType<typeof bucket>) =>
  [...b.objects.keys()].filter((k) => k.includes("oldtool-beta"));

describe("remark s3", () => {
  it("plans nothing without legacy data", async () => {
    seedOthers();
    tables.environment_archives = [];
    expect(await step.plan(ctx())).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    seedLegacy();
    seedOthers();
    expect(await step.plan(ctx())).toEqual([
      {
        step: "s3",
        target: "s3/backup-destination",
        from: OLD_BACKUP,
        to: NEW_BACKUP,
      },
      {
        step: "s3",
        target: "s3/backup-destination",
        from: OLD_ARCHIVE,
        to: NEW_ARCHIVE,
      },
      {
        step: "s3",
        target: `s3/connections/${CONN}`,
        from: OLD_CONN_ARCHIVE,
        to: NEW_CONN_ARCHIVE,
      },
    ]);
    // A dry run lists, nothing else.
    expect(
      [...dest.ops, ...conn.ops].filter((o) => !o.startsWith("list"))
    ).toEqual([]);
  });

  it("apply converts it", async () => {
    seedLegacy();
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(legacyKeys(dest)).toEqual([]);
    expect(legacyKeys(conn)).toEqual([]);
    expect(dest.objects.get(`acme/${NEW_BACKUP}database.dump`)?.body).toEqual(
      Buffer.from("dump-bytes")
    );
    expect([...dest.objects.keys()].sort()).toEqual([
      `acme/${NEW_BACKUP}database.dump`,
      `acme/${NEW_BACKUP}manifest.json`,
      `acme/${NEW_ARCHIVE}database.sql.gz`,
    ]);
    expect([...conn.objects.keys()]).toEqual([
      `${NEW_CONN_ARCHIVE}deploy-dir.tar.gz`,
    ]);
    // The rows follow, so the backup list and archive downloads keep working.
    expect(tables.instance_backups?.map((r) => r.objectKey)).toEqual([
      NEW_BACKUP,
      `oldtool-beta/${NAME}/`,
    ]);
    expect(tables.environment_archives?.map((r) => r.keyPrefix)).toEqual([
      `acme/${NEW_ARCHIVE}`,
      NEW_CONN_ARCHIVE,
    ]);
  });

  it("deletes only after verified copies", async () => {
    seedLegacy();
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    dest.ops.length = 0;
    await step.apply(ctx(), item);
    const ops = dest.ops.filter((o) => !o.startsWith("list"));
    // Both copies first; the multipart dump's copy is verified by reading
    // both objects (its ETag is not an MD5); then one delete of both keys.
    expect(ops).toEqual([
      `copy acme/${OLD_BACKUP}database.dump -> acme/${NEW_BACKUP}database.dump`,
      `read acme/${OLD_BACKUP}database.dump`,
      `copy acme/${OLD_BACKUP}manifest.json -> acme/${NEW_BACKUP}manifest.json`,
      `delete acme/${OLD_BACKUP}database.dump,acme/${OLD_BACKUP}manifest.json`,
    ]);
  });

  it("keeps the old objects when a copy fails", async () => {
    seedLegacy();
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    dest.faults.failCopy.add(`acme/${OLD_BACKUP}manifest.json`);
    await expect(step.apply(ctx(), item)).rejects.toThrow(
      /CopyObject failed.*old objects are kept/
    );
    expect(legacyKeys(dest)).toEqual([
      `acme/${OLD_BACKUP}database.dump`,
      `acme/${OLD_BACKUP}manifest.json`,
      `acme/${OLD_ARCHIVE}database.sql.gz`,
    ]);
    expect(dest.ops.some((o) => o.startsWith("delete"))).toBe(false);
    expect(tables.instance_backups?.[0]?.objectKey).toBe(OLD_BACKUP);
  });

  it("keeps the old objects when a copy's bytes differ", async () => {
    seedLegacy();
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    // Same size, other bytes: only the content comparison can tell.
    dest.faults.corruptCopy.add(`acme/${OLD_BACKUP}database.dump`);
    await expect(step.apply(ctx(), item)).rejects.toThrow(/differs/);
    expect(dest.objects.has(`acme/${OLD_BACKUP}database.dump`)).toBe(true);
    expect(dest.ops.some((o) => o.startsWith("delete"))).toBe(false);
    expect(tables.instance_backups?.[0]?.objectKey).toBe(OLD_BACKUP);
  });

  it("never overwrites another object under the new key", async () => {
    seedLegacy();
    dest.put(`acme/${NEW_BACKUP}manifest.json`, "{}");
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await expect(step.apply(ctx(), item)).rejects.toThrow(/size differs/);
    expect(dest.objects.get(`acme/${NEW_BACKUP}manifest.json`)?.body).toEqual(
      Buffer.from("{}")
    );
    expect(dest.objects.has(`acme/${OLD_BACKUP}manifest.json`)).toBe(true);
  });

  it("finishes a run that stopped after the copies", async () => {
    seedLegacy();
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    dest.faults.failDelete = true;
    await expect(step.apply(ctx(), item)).rejects.toThrow(
      /could not be deleted/
    );
    // Copied and recorded; the old objects are still there to delete.
    expect(tables.instance_backups?.[0]?.objectKey).toBe(NEW_BACKUP);
    dest.faults.failDelete = false;
    const [again] = await step.plan(ctx());
    if (!again) throw new Error("no item");
    await step.apply(ctx(), again);
    expect(legacyKeys(dest)).toEqual([`acme/${OLD_ARCHIVE}database.sql.gz`]);
  });

  it("is idempotent", async () => {
    seedLegacy();
    seedOthers();
    const items = await step.plan(ctx());
    for (const item of items) await step.apply(ctx(), item);
    for (const item of items) await step.apply(ctx(), item);
    expect(await step.plan(ctx())).toEqual([]);
  });
});

describe("copyObject", () => {
  // A fake S3 transport recording each request.
  function fakeS3() {
    const seen: {
      method: string;
      path: string;
      query: Record<string, string>;
      headers: Record<string, string>;
    }[] = [];
    const xml = (body: string) => ({
      response: {
        statusCode: 200,
        headers: { "content-type": "application/xml" },
        body: Readable.from([Buffer.from(body)]),
      },
    });
    const requestHandler = {
      async handle(request: {
        method: string;
        path: string;
        query: Record<string, string>;
        headers: Record<string, string>;
      }) {
        seen.push(request);
        if (request.query.uploads !== undefined) {
          return xml(
            "<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>"
          );
        }
        if (request.query.partNumber) {
          return xml(
            `<CopyPartResult><ETag>"p${request.query.partNumber}"</ETag></CopyPartResult>`
          );
        }
        if (request.query.uploadId) {
          return xml(
            '<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>'
          );
        }
        return xml('<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>');
      },
      updateHttpClientConfig() {},
      httpHandlerConfigs() {
        return {};
      },
    };
    return { seen, requestHandler: requestHandler as never };
  }

  async function client(requestHandler: never) {
    const { backupS3Client } = await import(
      "@/lib/instance-backup/destination"
    );
    return backupS3Client(
      {
        endpoint: "https://objects.example.test",
        region: "auto",
        forcePathStyle: true,
        accessKeyId: "AKFICTIONAL",
        secretAccessKey: "fictional-secret",
      },
      { requestHandler }
    );
  }

  it("copies a small object in one conditional CopyObject", async () => {
    const { copyObject } = await import("@/lib/instance-backup/destination");
    const s3 = fakeS3();
    await copyObject(
      await client(s3.requestHandler),
      "bkt",
      "oldtool-backups/a b/f",
      "menara-backups/x/f",
      { size: 10, etag: '"abc"' }
    );
    expect(s3.seen).toHaveLength(1);
    expect(s3.seen[0]?.method).toBe("PUT");
    expect(s3.seen[0]?.path).toBe("/bkt/menara-backups/x/f");
    expect(s3.seen[0]?.headers["x-amz-copy-source"]).toBe(
      "bkt/oldtool-backups/a%20b/f"
    );
    expect(s3.seen[0]?.headers["x-amz-copy-source-if-match"]).toBe('"abc"');
  });

  it("copies a large object in conditional part ranges", async () => {
    const { copyObject } = await import("@/lib/instance-backup/destination");
    const s3 = fakeS3();
    await copyObject(
      await client(s3.requestHandler),
      "bkt",
      "src",
      "dst",
      { size: 25, etag: '"m-3"', contentType: "application/gzip" },
      { singleMax: 10, partSize: 10 }
    );
    // CopyObject keeps the source's metadata; a multipart copy is told it.
    const created = s3.seen.find((r) => r.query.uploads !== undefined);
    expect(created?.headers["content-type"]).toBe("application/gzip");
    const parts = s3.seen.filter((r) => r.query.partNumber);
    expect(parts.map((r) => r.headers["x-amz-copy-source-range"])).toEqual([
      "bytes=0-9",
      "bytes=10-19",
      "bytes=20-24",
    ]);
    expect(
      parts.every((r) => r.headers["x-amz-copy-source-if-match"] === '"m-3"')
    ).toBe(true);
    expect(s3.seen.at(-1)?.query.uploadId).toBe("u1");
  });
});
