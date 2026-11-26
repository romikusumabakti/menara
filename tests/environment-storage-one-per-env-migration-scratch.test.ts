import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The one-storage-per-environment expand migration on real rows: a throwaway
// database made in the local menara-postgres container (superuser password
// read from the container, never printed) and dropped afterwards. Every
// migration before the new one runs first, the fixtures go in, then the real
// drizzle/ folder runs it.
//
//   ENVIRONMENT_STORAGE_ONE_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/environment-storage-one-per-env-migration-scratch.test.ts
const enabled = process.env.ENVIRONMENT_STORAGE_ONE_SCRATCH === "1";
const SUFFIX = "_environment_storage_one_per_env";

const suffix = randomBytes(4).toString("hex");
const dbName = `environment_storage_one_${suffix}`;
const password = enabled
  ? encodeURIComponent(
      execFileSync("podman", [
        "exec",
        "menara-postgres",
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    )
  : "";
const base = `postgres://postgres:${password}@127.0.0.1:5432`;

const id = (n: number) =>
  `0196a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const PROJECT = id(1);
const ENV_OWNED = id(10);
const ENV_DUP = id(11);
const ENV_TIE = id(12);
const ENV_DEST = id(13);
const SECRET = "enc:v1:ZmljdGlvbmFsLWNpcGhlcnRleHQ=";

const CONN_OWNED = id(100);
const CONN_DUP_OLD = id(101);
const CONN_DUP_NEW = id(102);
const CONN_TIE_LOW = id(103);
const CONN_TIE_HIGH = id(104);
const CONN_DEST = id(105);
const CONN_UNREF = id(106);
const CONN_ARCHIVED = id(107);
const CONN_BACKUP = id(108);
const ARCHIVE = id(200);

describe.skipIf(!enabled)(
  "one storage per environment migration on a real Postgres",
  () => {
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres>;
    let before: string | undefined;
    let migrationSql = "";

    const storage = async (environmentId: string) => {
      const [row] = await sql`select * from environment_storage
        where environment_id = ${environmentId}`;
      return row;
    };

    beforeAll(async () => {
      await admin.unsafe(`create database ${dbName}`);
      sql = postgres(`${base}/${dbName}`, {
        max: 2,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
      const db = drizzle({ client: sql });

      const folder = readdirSync("drizzle").find((e) => e.endsWith(SUFFIX));
      expect(folder).toBeDefined();
      migrationSql = readFileSync(
        join("drizzle", folder as string, "migration.sql"),
        "utf8"
      );

      before = mkdtempSync(join(tmpdir(), "menara-environment-storage-one-"));
      for (const entry of readdirSync("drizzle")) {
        if (entry === folder) continue;
        cpSync(join("drizzle", entry), join(before, entry), {
          recursive: true,
        });
      }
      await migrate(db, { migrationsFolder: before });

      await sql`insert into projects (id, name, key) values
        (${PROJECT}, 'ACME', 'ACME')`;
      await sql`insert into environments (id, project_id, name, slug) values
        (${ENV_OWNED}, ${PROJECT}, 'Owned', 'owned'),
        (${ENV_DUP}, ${PROJECT}, 'Dup', 'dup'),
        (${ENV_TIE}, ${PROJECT}, 'Tie', 'tie'),
        (${ENV_DEST}, ${PROJECT}, 'Dest', 'dest')`;
      await sql`insert into s3_connections
          (id, name, environment_id, endpoint, region, bucket, key_prefix,
           access_key_id, secret_key, force_path_style, updated_at)
        values
          (${CONN_OWNED}, 'Owned', ${ENV_OWNED}, 'https://s3.example.com',
           'eu-west-9', 'acme-files', 'team-a/', 'AKFICTIONAL1', ${SECRET},
           false, '2026-11-01'),
          (${CONN_DUP_OLD}, 'Old', ${ENV_DUP}, 'https://old.example.com',
           'us-east-1', 'old', null, 'AKOLD', 'legacy-plaintext', true,
           '2026-11-01'),
          (${CONN_DUP_NEW}, 'New', ${ENV_DUP}, 'https://new.example.com',
           'us-east-1', 'new', null, 'AKNEW', ${SECRET}, true, '2026-11-02'),
          (${CONN_TIE_LOW}, 'Low', ${ENV_TIE}, 'https://low.example.com',
           'us-east-1', 'low', null, 'AKLOW', ${SECRET}, true, '2026-11-03'),
          (${CONN_TIE_HIGH}, 'High', ${ENV_TIE}, 'https://high.example.com',
           'us-east-1', 'high', null, 'AKHIGH', ${SECRET}, true, '2026-11-03'),
          (${CONN_DEST}, 'Backups', ${ENV_DEST}, 'https://backup.example.com',
           'us-east-1', 'backups', null, 'AKBACKUP', ${SECRET}, true,
           '2026-11-01'),
          (${CONN_UNREF}, 'Unref', null, 'https://u.example.com', 'us-east-1',
           'unref', null, 'AKU', ${SECRET}, true, '2026-11-01'),
          (${CONN_ARCHIVED}, 'Archived', null, 'https://a.example.com',
           'us-east-1', 'archived', null, 'AKA', ${SECRET}, true,
           '2026-11-01')`;
      await sql`update instance_settings
        set backup_destination_id = ${CONN_DEST} where id = 1`;
      await sql`insert into environment_archives
          (id, environment_id, project_name, environment_name, environment_slug,
           expires_at, location, s3_connection_id, key_prefix)
        values (${ARCHIVE}, null, 'ACME', 'Old', 'old',
          now() + interval '30 days', 's3', ${CONN_ARCHIVED},
          'environment-archives/x/')`;

      await migrate(db, { migrationsFolder: "drizzle" });
    });

    afterAll(async () => {
      if (before) rmSync(before, { recursive: true, force: true });
      await sql?.end();
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    });

    it("copies the owned connection with its secret byte-identical", async () => {
      expect(await storage(ENV_OWNED)).toMatchObject({
        endpoint: "https://s3.example.com",
        region: "eu-west-9",
        bucket: "acme-files",
        key_prefix: "team-a/",
        access_key_id: "AKFICTIONAL1",
        secret_key: SECRET,
        force_path_style: false,
      });
    });

    it("keeps the newest of two rows for one environment", async () => {
      expect(await storage(ENV_DUP)).toMatchObject({
        bucket: "new",
        access_key_id: "AKNEW",
      });
    });

    it("breaks updated_at ties by id desc", async () => {
      expect(await storage(ENV_TIE)).toMatchObject({ bucket: "high" });
    });

    it("never copies the legacy backup-destination connection", async () => {
      expect(await storage(ENV_DEST)).toBeUndefined();
    });

    it("deletes unreferenced unassigned rows", async () => {
      const rows = await sql`select id from s3_connections
        where id = ${CONN_UNREF}`;
      expect(rows).toHaveLength(0);
    });

    it("keeps an unassigned row referenced by an archive", async () => {
      const rows = await sql`select id from s3_connections
        where id = ${CONN_ARCHIVED}`;
      expect(rows).toHaveLength(1);
    });

    it("keeps an unassigned row referenced by backup_destination_id", async () => {
      const statement = migrationSql
        .split("--> statement-breakpoint")
        .find((s) => /DELETE FROM "s3_connections"/.test(s));
      expect(statement).toBeDefined();
      // Inserted after the migration, so the real run did not already keep it.
      await sql`insert into s3_connections
          (id, name, endpoint, bucket, access_key_id, secret_key)
        values (${CONN_BACKUP}, 'Backups', 'https://b.example.com', 'bk',
          'AKB', ${SECRET})`;
      await sql`update instance_settings
        set backup_destination_id = ${CONN_BACKUP} where id = 1`;
      try {
        await sql.unsafe(statement as string);
        const rows = await sql`select id from s3_connections
          where id = ${CONN_BACKUP}`;
        expect(rows).toHaveLength(1);
      } finally {
        await sql`update instance_settings
          set backup_destination_id = ${CONN_DEST} where id = 1`;
        await sql`delete from s3_connections where id = ${CONN_BACKUP}`;
      }
    });

    it("old rows stay in s3_connections for owned envs", async () => {
      const rows = await sql`select id from s3_connections
        where environment_id is not null order by id`;
      expect(rows.map((r) => r.id)).toEqual([
        CONN_OWNED,
        CONN_DUP_OLD,
        CONN_DUP_NEW,
        CONN_TIE_LOW,
        CONN_TIE_HIGH,
        CONN_DEST,
      ]);
    });

    it("re-running the backfill statements is a no-op", async () => {
      const statements = migrationSql
        .split("--> statement-breakpoint")
        .filter((s) =>
          /^\s*(--[^\n]*\n)*\s*(INSERT INTO "environment_storage"|DELETE FROM "s3_connections")/.test(
            s
          )
        );
      expect(statements).toHaveLength(2);
      const count = async () => {
        const [a] =
          await sql`select count(*)::int as n from environment_storage`;
        const [b] = await sql`select count(*)::int as n from s3_connections`;
        return [a?.n, b?.n];
      };
      const first = await count();
      for (const statement of statements) await sql.unsafe(statement);
      expect(await count()).toEqual(first);
    });

    it("rejects a key prefix that is not normalised", async () => {
      for (const prefix of ["", "/team-a/", "team-a"]) {
        await expect(
          sql`update environment_storage set key_prefix = ${prefix}
            where environment_id = ${ENV_OWNED}`
        ).rejects.toThrow(/environment_storage_key_prefix_check/);
      }
    });
  }
);
