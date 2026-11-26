import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Storage per environment against a real Postgres: a throwaway database in the
// local menara-postgres container (superuser password read from the
// container, never printed), migrated with `menara migrate` and dropped
// afterwards. Covers who may read, save, remove and test an environment's
// one storage (view = sees the environment, manage = edits its settings +
// a strong sign-in), that an environment the caller can't see answers 404,
// that secrets never come back and stay with their location, the backup
// destination refusals, the activity rows, that saves, removes and both
// environment deletes drain the environment's old s3_connections rows, the
// removal of the admin handling of unassigned connections, and the explorer's
// access rule for an environment's storage (that environment's rights).
//
//   ENVIRONMENT_STORAGE_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/environment-storage-scratch.test.ts
const enabled = process.env.ENVIRONMENT_STORAGE_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `environment_storage_service_${randomBytes(4).toString("hex")}`;
process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");

const session = vi.hoisted(() => ({
  user: { id: "", role: "admin", name: "Admin" },
  signInMethod: "passkey",
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: session.user,
    session: { signInMethod: session.signInMethod },
  });
  return { requireSession: current, getServerSession: current };
});
// saveInstanceBackupSettings reschedules the daily job; no queue here.
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(),
  scheduleInstanceBackup: vi.fn(async () => {}),
  INSTANCE_BACKUP_MANUAL_JOB_ID: "instance-backup-manual",
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

// The S3 side: no network. createS3Backend records the connection it was
// opened with (resolveBackend's decrypted row); the probe records its input.
const s3 = vi.hoisted(() => ({
  opened: [] as Record<string, unknown>[],
  probes: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/explorer/s3", () => ({
  createS3Backend: (conn: Record<string, unknown>) => {
    s3.opened.push(conn);
    return {
      list: async () => [],
      remove: async () => {},
      writeStream: async () => {},
      readStream: async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([]);
      },
    };
  },
  testS3Connection: async (probe: Record<string, unknown>) => {
    s3.probes.push(probe);
    return { ok: true };
  },
}));

const ADMIN = "00000000-0000-7000-8000-00000000e001";
const INFRA = "00000000-0000-7000-8000-00000000e002";
const ENGINEER = "00000000-0000-7000-8000-00000000e003";
const QA = "00000000-0000-7000-8000-00000000e004";
const STAFF = "00000000-0000-7000-8000-00000000e005";
const BA = "00000000-0000-7000-8000-00000000e006";
const PM = "00000000-0000-7000-8000-00000000e007";
const OBSERVER = "00000000-0000-7000-8000-00000000e008";
const PROJECT_A = "00000000-0000-7000-8000-00000000a001";
const PROJECT_B = "00000000-0000-7000-8000-00000000b001";
const ENV_A = "00000000-0000-7000-8000-00000000a0e1";
const ENV_A2 = "00000000-0000-7000-8000-00000000a0e2";
const ENV_B = "00000000-0000-7000-8000-00000000b0e1";
const CONN_A = "00000000-0000-7000-8000-00000000a0c1";
const CONN_B = "00000000-0000-7000-8000-00000000b0c1";
const CONN_FREE = "00000000-0000-7000-8000-0000000000c1";
const CONN_BACKUP = "00000000-0000-7000-8000-0000000000c2";
const MISSING = "00000000-0000-7000-8000-0000000000ff";
// Fictional credentials; the secrets are what must never come back.
const SECRET_A = "fictional-secret-a-7f3c";
const SECRET_B = "fictional-secret-b-91de";

const as = (id: string, role: string, signInMethod = "passkey") => {
  session.user = { id, role, name: role };
  session.signInMethod = signInMethod;
};

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof HTTPException) {
      return { status: error.status, code: (error as { code?: string }).code };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

// The location fields a saved fixture row holds (see beforeEach).
const stored = (id: string) => ({
  endpoint: "https://objects.example.test",
  region: "us-east-1",
  bucket: "fictional-app-bucket",
  accessKeyId: id === CONN_A ? "AKKESTRELFILES" : "AKHERONFILES",
  forcePathStyle: true,
  keyPrefix: id === CONN_A ? "team-a/" : "team-b/",
});

// The same location as environment_storage columns.
const storedColumns = (id: string) => {
  const { accessKeyId, keyPrefix, forcePathStyle, ...rest } = stored(id);
  return {
    ...rest,
    access_key_id: accessKeyId,
    key_prefix: keyPrefix,
    force_path_style: forcePathStyle,
  };
};

const input = (over: Record<string, unknown> = {}) => ({
  endpoint: "https://objects.example.test",
  region: "us-east-1",
  bucket: "fictional-app-bucket",
  accessKeyId: "AKFICTIONALNEW",
  secretKey: "fictional-secret-new-55aa",
  forcePathStyle: true,
  keyPrefix: null,
  ...over,
});

describe.skipIf(!enabled)("environment storage on Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let svc: typeof import("@/server/services/environment-storage");
  let admin: typeof import("@/server/services/s3-connections");
  let explorer: typeof import("@/server/services/explorer");
  let backups: typeof import("@/server/services/instance-backups");
  let app: typeof import("@/server/app")["app"];
  let decryptSecret: typeof import("@/lib/secrets")["decryptSecret"];
  let encryptSecret: typeof import("@/lib/secrets")["encryptSecret"];

  const activity = (action: string) =>
    sql<{ entity_id: string; data: Record<string, string> }[]>`
      select entity_id, data from activity_log where action = ${action}
      order by created_at`;
  const connection = async (id: string) => {
    const [row] = await sql<
      {
        name: string;
        environment_id: string | null;
        key_prefix: string | null;
        secret_key: string;
      }[]
    >`select name, environment_id, key_prefix, secret_key
      from s3_connections where id = ${id}`;
    return row;
  };
  const storageRow = async (environmentId: string) => {
    const [row] = await sql<
      { key_prefix: string | null; bucket: string; secret_key: string }[]
    >`select key_prefix, bucket, secret_key from environment_storage
      where environment_id = ${environmentId}`;
    return row;
  };
  // After a delete test: ENV_A back (its rows come back in beforeEach).
  const restoreEnvA = async () => {
    await sql`insert into environments (id, project_id, name, slug) values
      (${ENV_A}, ${PROJECT_A}, 'Kestrel QA', 'qa')`;
  };

  beforeAll(async () => {
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    const base = `postgres://postgres:${password}@127.0.0.1:5432`;
    const root = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    await root.unsafe(`create database ${DB_NAME}`);
    await root.end();
    const url = `${base}/${DB_NAME}`;
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    for (const [id, role] of [
      [ADMIN, "admin"],
      [INFRA, "infra"],
      [ENGINEER, "engineer"],
      [QA, "qa"],
      [STAFF, "staff"],
      [BA, "ba"],
      [PM, "pm"],
      [OBSERVER, "observer"],
    ] as const) {
      await sql`insert into users (id, name, email, role)
        values (${id}, ${role}, ${`${role}@example.com`}, ${role})`;
    }
    await sql`insert into projects (id, name, key) values
      (${PROJECT_A}, 'Kestrel', 'KES'), (${PROJECT_B}, 'Heron', 'HER')`;
    // The engineer and the QA work on Kestrel only; Heron is invisible.
    await sql`insert into project_members (project_id, user_id) values
      (${PROJECT_A}, ${ENGINEER}), (${PROJECT_A}, ${QA}),
      (${PROJECT_A}, ${BA}), (${PROJECT_A}, ${PM}), (${PROJECT_B}, ${STAFF})`;
    await sql`insert into environments (id, project_id, name, slug) values
      (${ENV_A}, ${PROJECT_A}, 'Kestrel QA', 'qa'),
      (${ENV_A2}, ${PROJECT_A}, 'Kestrel UAT', 'uat'),
      (${ENV_B}, ${PROJECT_B}, 'Heron QA', 'qa')`;
    ({ encryptSecret, decryptSecret } = await import("@/lib/secrets"));
    backups = await import("@/server/services/instance-backups");
    svc = await import("@/server/services/environment-storage");
    admin = await import("@/server/services/s3-connections");
    explorer = await import("@/server/services/explorer");
    ({ app } = await import("@/server/app"));
  });

  afterAll(async () => {
    await sql?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (!enabled) return;
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    const root = postgres(
      `postgres://postgres:${password}@127.0.0.1:5432/postgres`,
      { max: 1, onnotice: () => {} }
    );
    await root.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await root.end();
  });

  beforeEach(async () => {
    await sql`delete from activity_log`;
    await sql`delete from environment_archives`;
    await sql`update instance_settings set backup_destination_id = null`;
    await sql`delete from s3_connections`;
    const row = (
      id: string,
      name: string,
      environmentId: string | null,
      keyPrefix: string | null,
      secret: string
    ) => ({
      id,
      name,
      environment_id: environmentId,
      endpoint: "https://objects.example.test",
      region: "us-east-1",
      bucket: "fictional-app-bucket",
      key_prefix: keyPrefix,
      access_key_id: `AK${name.replace(/\W/g, "").toUpperCase()}`,
      secret_key: encryptSecret(secret),
      force_path_style: true,
    });
    await sql`insert into s3_connections ${sql([
      row(CONN_A, "Kestrel files", ENV_A, "team-a/", SECRET_A),
      row(CONN_B, "Heron files", ENV_B, "team-b/", SECRET_B),
      row(CONN_FREE, "Old bucket", null, null, "fictional-secret-free"),
      row(CONN_BACKUP, "Menara backups", null, null, "fictional-secret-backup"),
    ])}`;
    await sql`delete from environment_storage`;
    await sql`insert into environment_storage ${sql([
      {
        environment_id: ENV_A,
        ...storedColumns(CONN_A),
        secret_key: encryptSecret(SECRET_A),
      },
      {
        environment_id: ENV_B,
        ...storedColumns(CONN_B),
        secret_key: encryptSecret(SECRET_B),
      },
    ])}`;
    await sql`insert into instance_settings (id, backup_destination_id)
      values (1, ${CONN_BACKUP})
      on conflict (id) do update set backup_destination_id = ${CONN_BACKUP}`;
    s3.opened = [];
    s3.probes = [];
    as(ENGINEER, "engineer");
  });

  describe("viewing an environment's storage", () => {
    it("answers the environment's one storage without its secret", async () => {
      for (const [id, role] of [
        [ENGINEER, "engineer"],
        [QA, "qa"],
      ] as const) {
        as(id, role);
        const got = await svc.getEnvironmentStorage(ENV_A);
        expect(got).toMatchObject({
          environmentId: ENV_A,
          keyPrefix: "team-a/",
          hasSecret: true,
          isBackupDestination: false,
        });
        expect(got).not.toHaveProperty("secretKey");
        expect(JSON.stringify(got)).not.toContain(SECRET_A);
        expect(JSON.stringify(got)).not.toContain("enc:v1:");
      }
      // A sibling environment of the same project has none of its own.
      expect(await svc.getEnvironmentStorage(ENV_A2)).toBeNull();
    });

    it("answers 404 for an environment the caller can't see", async () => {
      expect(await refusal(svc.getEnvironmentStorage(ENV_B))).toMatchObject({
        status: 404,
      });
      expect(await refusal(svc.getEnvironmentStorage(MISSING))).toMatchObject({
        status: 404,
      });
      // staff is a member of Heron but sees no project at all.
      as(STAFF, "staff");
      expect(await refusal(svc.getEnvironmentStorage(ENV_B))).toMatchObject({
        status: 404,
      });
    });

    it("serves it over the API with the same answers", async () => {
      const ok = await app.request(`/api/environments/${ENV_A}/storage`);
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).toContain(ENV_A);
      expect(body).not.toContain(SECRET_A);
      expect(body).not.toContain("secretKey");
      const unset = await app.request(`/api/environments/${ENV_A2}/storage`);
      expect(await unset.json()).toBeNull();
      const hidden = await app.request(`/api/environments/${ENV_B}/storage`);
      expect(hidden.status).toBe(404);
      // The per-connection routes are gone.
      const old = await app.request(
        `/api/environments/${ENV_A}/storage/${CONN_A}`
      );
      expect(old.status).toBe(404);
    });
  });

  describe("managing an environment's storage", () => {
    it("saves a first storage with a normalised prefix and an encrypted secret, draining the old rows", async () => {
      const saved = await svc.saveEnvironmentStorage(
        ENV_A2,
        input({ keyPrefix: "  /uploads/2026 " })
      );
      expect(saved).toMatchObject({
        environmentId: ENV_A2,
        keyPrefix: "uploads/2026/",
        hasSecret: true,
      });
      expect(saved).not.toHaveProperty("secretKey");
      expect(JSON.stringify(saved)).not.toContain("fictional-secret-new");
      const row = await storageRow(ENV_A2);
      expect(row?.secret_key.startsWith("enc:v1:")).toBe(true);
      expect(decryptSecret(row?.secret_key ?? "")).toBe(
        "fictional-secret-new-55aa"
      );
      // ENV_A's old connection stays: only the saved environment is drained.
      expect(await connection(CONN_A)).toBeDefined();
      await svc.saveEnvironmentStorage(ENV_A, {
        ...stored(CONN_A),
        secretKey: undefined,
      });
      expect(await connection(CONN_A)).toBeUndefined();
      expect(await connection(CONN_B)).toBeDefined();
      expect(await activity("storage.configured")).toEqual([
        {
          entity_id: ENV_A2,
          data: {
            environment: "Kestrel · UAT",
            fields:
              "endpoint, region, bucket, keyPrefix, accessKeyId, forcePathStyle, secretKey",
          },
        },
        {
          entity_id: ENV_A,
          data: { environment: "Kestrel · QA", fields: "" },
        },
      ]);
    });

    it("never writes another environment's row through the body", async () => {
      const res = await app.request(`/api/environments/${ENV_A}/storage`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input(), environmentId: ENV_B }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("fictional-secret-new");
      expect(decryptSecret((await storageRow(ENV_B))?.secret_key ?? "")).toBe(
        SECRET_B
      );
    });

    it.each([
      "../team-b",
      "team-a/../../",
      "a//b",
      "a\\b",
      "%2e%2e/",
      "a%2Fb",
      "．．",
    ])("refuses the prefix %j with a coded 400", async (keyPrefix) => {
      expect(
        await refusal(svc.saveEnvironmentStorage(ENV_A, input({ keyPrefix })))
      ).toEqual({ status: 400, code: "s3KeyPrefixInvalid" });
      expect((await storageRow(ENV_A))?.key_prefix).toBe("team-a/");
    });

    it("removes the storage and the old rows", async () => {
      await svc.removeEnvironmentStorage(ENV_A);
      expect(await storageRow(ENV_A)).toBeUndefined();
      expect(await connection(CONN_A)).toBeUndefined();
      expect(await activity("storage.removed")).toEqual([
        { entity_id: ENV_A, data: { environment: "Kestrel · QA" } },
      ]);
      // Removing nothing is fine and records nothing.
      await svc.removeEnvironmentStorage(ENV_A);
      expect(await activity("storage.removed")).toHaveLength(1);
    });

    it("refuses QA (view only) with a 403", async () => {
      as(QA, "qa");
      for (const call of [
        () => svc.saveEnvironmentStorage(ENV_A, input()),
        () => svc.removeEnvironmentStorage(ENV_A),
        () =>
          svc.testEnvironmentStorage(ENV_A, {
            ...stored(CONN_A),
            secretKey: undefined,
          }),
      ]) {
        expect(await refusal(call())).toMatchObject({ status: 403 });
      }
      expect((await storageRow(ENV_A))?.key_prefix).toBe("team-a/");
    });

    it("refuses a weak sign-in for every change", async () => {
      as(ENGINEER, "engineer", "password");
      for (const call of [
        () => svc.saveEnvironmentStorage(ENV_A, input()),
        () => svc.removeEnvironmentStorage(ENV_A),
        () => svc.testEnvironmentStorage(ENV_A, input()),
      ]) {
        expect(await refusal(call())).toMatchObject({
          status: 403,
          code: "strong_sign_in_required",
        });
      }
      // Reading is fine.
      expect(await svc.getEnvironmentStorage(ENV_A)).not.toBeNull();
    });

    it("answers 404 for every change aimed at an invisible environment", async () => {
      for (const env of [ENV_B, MISSING]) {
        expect(
          await refusal(svc.saveEnvironmentStorage(env, input()))
        ).toMatchObject({ status: 404 });
        expect(await refusal(svc.removeEnvironmentStorage(env))).toMatchObject({
          status: 404,
        });
        expect(
          await refusal(svc.testEnvironmentStorage(env, input()))
        ).toMatchObject({ status: 404 });
      }
      expect(await storageRow(ENV_B)).toBeDefined();
      expect(s3.probes).toEqual([]);
      expect(await activity("storage.configured")).toEqual([]);
    });

    it("tests the saved storage with its stored secret and the prefix", async () => {
      const result = await svc.testEnvironmentStorage(ENV_A, {
        ...stored(CONN_A),
        keyPrefix: " /team-a",
        secretKey: undefined,
      });
      expect(result).toEqual({ ok: true });
      expect(s3.probes).toEqual([
        expect.objectContaining({
          secretKey: SECRET_A,
          keyPrefix: "team-a/",
          bucket: "fictional-app-bucket",
        }),
      ]);
      expect(
        await refusal(
          svc.testEnvironmentStorage(ENV_A, input({ keyPrefix: "../x" }))
        )
      ).toEqual({ status: 400, code: "s3KeyPrefixInvalid" });
      // Nothing stored and nothing typed: a coded answer, no probe.
      expect(
        await svc.testEnvironmentStorage(ENV_A2, {
          ...input(),
          secretKey: undefined,
        })
      ).toEqual({ ok: false, code: "s3SecretRequiredForTest" });
      expect(s3.probes).toHaveLength(1);
    });
  });

  describe("the stored secret stays with its location", () => {
    it.each([
      ["keyPrefix", null],
      ["keyPrefix", "team-b/"],
      ["bucket", "fictional-other-bucket"],
      ["endpoint", "https://collector.example.test"],
      ["region", "eu-west-1"],
      ["accessKeyId", "AKSOMEONEELSE"],
      ["forcePathStyle", false],
    ])("refuses changing %s without a new secret", async (field, value) => {
      const moved = { ...stored(CONN_A), [field]: value, secretKey: undefined };
      expect(await refusal(svc.saveEnvironmentStorage(ENV_A, moved))).toEqual({
        status: 400,
        code: "s3SecretRequiredForLocationChange",
      });
      const row = await storageRow(ENV_A);
      expect(row?.key_prefix).toBe("team-a/");
      expect(decryptSecret(row?.secret_key ?? "")).toBe(SECRET_A);
      // The probe pairs the stored secret only with the stored location.
      expect(await refusal(svc.testEnvironmentStorage(ENV_A, moved))).toEqual({
        status: 400,
        code: "s3SecretRequiredForLocationChange",
      });
      expect(s3.probes).toEqual([]);
    });

    it("accepts a location change that brings its own secret", async () => {
      const saved = await svc.saveEnvironmentStorage(ENV_A, {
        ...stored(CONN_A),
        keyPrefix: "team-a/archive",
        bucket: "fictional-other-bucket",
        secretKey: "fictional-secret-for-other",
      });
      expect(saved).toMatchObject({
        keyPrefix: "team-a/archive/",
        bucket: "fictional-other-bucket",
      });
      expect(decryptSecret((await storageRow(ENV_A))?.secret_key ?? "")).toBe(
        "fictional-secret-for-other"
      );
      await svc.testEnvironmentStorage(ENV_A, {
        ...stored(CONN_A),
        bucket: "fictional-third-bucket",
        secretKey: "fictional-typed-secret",
      });
      expect(s3.probes).toEqual([
        expect.objectContaining({
          bucket: "fictional-third-bucket",
          secretKey: "fictional-typed-secret",
        }),
      ]);
    });

    it("keeps the secret on an unchanged re-save", async () => {
      await svc.saveEnvironmentStorage(ENV_A, {
        ...stored(CONN_A),
        keyPrefix: "/team-a",
        secretKey: "",
      });
      expect(decryptSecret((await storageRow(ENV_A))?.secret_key ?? "")).toBe(
        SECRET_A
      );
    });
  });

  describe("environment deletes drain the old rows", () => {
    it("the row-only delete removes the environment's s3_connections rows", async () => {
      const { deleteEnvironment } = await import(
        "@/server/services/environments"
      );
      as(ADMIN, "admin");
      expect(await deleteEnvironment(ENV_A)).toMatchObject({ success: true });
      // Not left behind with a nulled environment_id.
      expect(await connection(CONN_A)).toBeUndefined();
      expect(await storageRow(ENV_A)).toBeUndefined();
      expect(await connection(CONN_B)).toBeDefined();
      await restoreEnvA();
    });

    it("the teardown delete removes them too, and a refused one keeps them", async () => {
      const { deleteTeardownEnvironment } = await import(
        "@/lib/teardown/repository"
      );
      await sql`insert into environment_variables (environment_id, name,
          kind, value, escrow)
        values (${ENV_A}, 'DATA_ENCRYPTION_KEY', 'secret', 'fictional', true)`;
      expect(
        await deleteTeardownEnvironment(ENV_A, ADMIN, {
          escrowConfirmed: false,
        })
      ).toEqual({ refusal: "environmentHasEscrowedVariables" });
      expect(await connection(CONN_A)).toBeDefined();
      expect(
        await deleteTeardownEnvironment(ENV_A, ADMIN, { escrowConfirmed: true })
      ).toMatchObject({ environmentName: "Kestrel QA" });
      expect(await connection(CONN_A)).toBeUndefined();
      await restoreEnvA();
    });
  });

  describe("draining keeps the rows legacy code still reads", () => {
    // Every drain caller, run on ENV_A; the deletes put ENV_A back after.
    const callers: [string, () => Promise<unknown>][] = [
      [
        "save",
        () =>
          svc.saveEnvironmentStorage(ENV_A, {
            ...stored(CONN_A),
            secretKey: undefined,
          }),
      ],
      ["remove", () => svc.removeEnvironmentStorage(ENV_A)],
      [
        "environment delete",
        async () => {
          const { deleteEnvironment } = await import(
            "@/server/services/environments"
          );
          as(ADMIN, "admin");
          await deleteEnvironment(ENV_A);
        },
      ],
      [
        "teardown delete",
        async () => {
          const { deleteTeardownEnvironment } = await import(
            "@/lib/teardown/repository"
          );
          await deleteTeardownEnvironment(ENV_A, ADMIN, {
            escrowConfirmed: true,
          });
        },
      ],
    ];
    const run = async (call: () => Promise<unknown>) => {
      await call();
      const [env] = await sql`select 1 from environments where id = ${ENV_A}`;
      if (!env) await restoreEnvA();
    };

    it.each(callers)(
      "%s detaches a connection an archive still names",
      async (_name, call) => {
        const { loadArchiveStore } = await import(
          "@/lib/teardown/archive-store"
        );
        await sql`insert into environment_archives (environment_id,
            project_name, environment_name, environment_slug, expires_at,
            location, s3_connection_id, key_prefix, completed_at)
          values (${MISSING}, 'Kestrel', 'Kestrel Old', 'old',
            now() + interval '30 days', 's3', ${CONN_A}, 'archives/old/',
            now())`;
        await run(call);
        expect(await connection(CONN_A)).toMatchObject({
          environment_id: null,
        });
        expect(
          await loadArchiveStore({
            inBackupDestination: false,
            s3Endpoint: null,
            s3Bucket: null,
            s3ConnectionId: CONN_A,
          })
        ).not.toBeNull();
      }
    );

    it.each(callers)(
      "%s detaches the legacy backup destination's connection",
      async (_name, call) => {
        await sql`update instance_settings set backup_destination_id = ${CONN_A}
          where id = 1`;
        await run(call);
        expect(await connection(CONN_A)).toMatchObject({
          environment_id: null,
        });
        const [row] = await sql<{ backup_destination_id: string | null }[]>`
          select backup_destination_id from instance_settings where id = 1`;
        expect(row?.backup_destination_id).toBe(CONN_A);
      }
    );

    it.each(callers)(
      "%s deletes an unreferenced connection",
      async (_name, call) => {
        await run(call);
        expect(await connection(CONN_A)).toBeUndefined();
        expect(await connection(CONN_B)).toBeDefined();
      }
    );
  });

  describe("the instance backup destination", () => {
    it("is never saved or probed as environment storage, but a restricted one can be removed", async () => {
      await sql`update instance_settings set
          backup_s3_endpoint = 'https://objects.example.test',
          backup_s3_region = 'us-east-1',
          backup_s3_bucket = 'fictional-app-bucket',
          backup_s3_access_key_id = 'AKMENARABACKUPS',
          backup_s3_secret_key = ${encryptSecret("fictional-secret-backup")},
          backup_s3_key_prefix = 'team-a/'
        where id = 1`;
      try {
        // ENV_A's stored config now sits inside the destination.
        expect(await svc.getEnvironmentStorage(ENV_A)).toMatchObject({
          isBackupDestination: true,
        });
        expect(
          await refusal(
            svc.testEnvironmentStorage(ENV_A, {
              ...stored(CONN_A),
              secretKey: undefined,
            })
          )
        ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
        for (const keyPrefix of [null, "team-a/", "team-a/sub/"]) {
          expect(
            await refusal(
              svc.saveEnvironmentStorage(ENV_A2, input({ keyPrefix }))
            ),
            String(keyPrefix)
          ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
        }
        expect(await storageRow(ENV_A2)).toBeUndefined();
        expect(s3.probes).toEqual([]);
        // Replaced by one outside it, or removed.
        await svc.saveEnvironmentStorage(
          ENV_A,
          input({ keyPrefix: "reports/" })
        );
        expect(await svc.getEnvironmentStorage(ENV_A)).toMatchObject({
          isBackupDestination: false,
        });
        await sql`update environment_storage set key_prefix = 'team-a/'
          where environment_id = ${ENV_A}`;
        await svc.removeEnvironmentStorage(ENV_A);
        expect(await storageRow(ENV_A)).toBeUndefined();
      } finally {
        await sql`update instance_settings set backup_s3_endpoint = null,
            backup_s3_region = null, backup_s3_bucket = null,
            backup_s3_access_key_id = null, backup_s3_secret_key = null,
            backup_s3_key_prefix = null
          where id = 1`;
      }
    });
    it("is no longer picked from the connections: the schedule save leaves the legacy setting alone", async () => {
      as(ADMIN, "admin");
      // An old client still sending destinationId: dropped by the schema.
      expect(
        await backups.saveInstanceBackupSettings({
          time: "02:00",
          keepDaily: 7,
          keepWeekly: 4,
          destinationId: CONN_A,
        } as never)
      ).toEqual({ success: true });
      const [row] = await sql<{ backup_destination_id: string | null }[]>`
        select backup_destination_id from instance_settings where id = 1`;
      expect(row?.backup_destination_id).toBe(CONN_BACKUP);
      const page = await backups.getInstanceBackups();
      expect(page).not.toHaveProperty("destinations");
    });
  });

  describe("removed connection routes", () => {
    it("has no org-wide list, read, create, edit, delete or probe any more", async () => {
      as(ADMIN, "admin");
      for (const [method, path] of [
        ["GET", "/api/s3-connections/get-s3-connections"],
        ["GET", `/api/s3-connections/get-s3-connection?id=${CONN_B}`],
        ["POST", "/api/s3-connections/create-s3-connection"],
        ["POST", "/api/s3-connections/update-s3-connection"],
        ["POST", "/api/s3-connections/delete-s3-connection"],
        ["POST", "/api/s3-connections/test-s3-connection-action"],
        ["GET", "/api/s3-connections/list-unassigned-s3-connections"],
        ["POST", "/api/s3-connections/assign-s3-connection"],
        ["POST", "/api/s3-connections/delete-unassigned-s3-connection"],
      ] as const) {
        const res = await app.request(path, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "POST"
            ? { body: JSON.stringify({ id: CONN_B }) }
            : {}),
        });
        expect(res.status, path).toBe(404);
      }
      expect(await connection(CONN_B)).toBeDefined();
    });
  });

  describe("where an old /storage/<id> link leads", () => {
    const location = (id: string) =>
      app.request(`/api/s3-connections/get-s3-connection-location?id=${id}`);

    it("answers an assigned connection's environment to whoever sees it", async () => {
      for (const [id, role] of [
        [ENGINEER, "engineer"],
        [QA, "qa"],
        [ADMIN, "admin"],
      ] as const) {
        as(id, role);
        expect(await admin.getS3ConnectionLocation(CONN_A)).toEqual({
          kind: "environment",
          projectKey: "KES",
          envSlug: "qa",
        });
      }
      as(ENGINEER, "engineer");
      const res = await location(CONN_A);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({
        kind: "environment",
        projectKey: "KES",
        envSlug: "qa",
      });
      expect(body).not.toContain("fictional-app-bucket");
    });

    it("answers 404 alike for another project's, an unassigned and a missing connection", async () => {
      for (const [user, role] of [
        [ENGINEER, "engineer"],
        [QA, "qa"],
      ] as const) {
        as(user, role);
        for (const id of [CONN_B, CONN_FREE, CONN_BACKUP, MISSING]) {
          expect(
            await refusal(admin.getS3ConnectionLocation(id)),
            `${role} ${id}`
          ).toMatchObject({ status: 404 });
        }
      }
      // The observer sees every project, but not the unassigned connections
      // (an unassigned connection has no location).
      as(OBSERVER, "observer");
      expect(await admin.getS3ConnectionLocation(CONN_B)).toMatchObject({
        kind: "environment",
        projectKey: "HER",
      });
      for (const id of [CONN_FREE, CONN_BACKUP, MISSING]) {
        expect(
          await refusal(admin.getS3ConnectionLocation(id)),
          `observer ${id}`
        ).toMatchObject({ status: 404 });
      }
      as(ENGINEER, "engineer");
      expect((await location(CONN_B)).status).toBe(404);
      expect((await location(MISSING)).status).toBe(404);
    });

    it("answers 404 for an unassigned connection, even to the storage managers", async () => {
      for (const [user, role] of [
        [ADMIN, "admin"],
        [INFRA, "infra"],
      ] as const) {
        as(user, role);
        for (const id of [CONN_FREE, CONN_BACKUP, MISSING]) {
          expect(
            await refusal(admin.getS3ConnectionLocation(id)),
            `${role} ${id}`
          ).toMatchObject({ status: 404 });
        }
      }
    });
  });

  describe("the explorer on an environment's storage", () => {
    const src = (environmentId: string) => ({ kind: "s3", environmentId });

    it("shows the storage but opens no files for QA, BA, PM and observer", async () => {
      for (const [id, role] of [
        [QA, "qa"],
        [BA, "ba"],
        [PM, "pm"],
        [OBSERVER, "observer"],
      ] as const) {
        as(id, role);
        expect(await svc.getEnvironmentStorage(ENV_A)).not.toBeNull();
        for (const call of [
          () => explorer.listEntries(src(ENV_A), ""),
          () => explorer.getDownloadTarget(src(ENV_A), "a.txt"),
          () => explorer.readFileText(src(ENV_A), "a.txt"),
          () => explorer.folderStats(src(ENV_A), ""),
          () => explorer.deleteEntry(src(ENV_A), "a.txt"),
        ]) {
          expect(await refusal(call())).toMatchObject({ status: 403 });
        }
        for (const route of ["download", "archive"]) {
          const res = await app.request(
            `/api/explorer/${route}?source=${encodeURIComponent(
              JSON.stringify(src(ENV_A))
            )}&path=a.txt`
          );
          expect(res.status).toBe(403);
        }
      }
      expect(s3.opened).toEqual([]);
    });

    it("browses as an engineer, confined to the prefix", async () => {
      as(ENGINEER, "engineer");
      expect(await explorer.listEntries(src(ENV_A), "")).toEqual({
        success: true,
        data: [],
      });
      expect(s3.opened).toEqual([
        expect.objectContaining({
          bucket: "fictional-app-bucket",
          keyPrefix: "team-a/",
          secretKey: SECRET_A,
        }),
      ]);
    });

    it("changes files with the environment's manage right", async () => {
      as(ENGINEER, "engineer");
      expect(await explorer.deleteEntry(src(ENV_A), "a.txt")).toMatchObject({
        success: true,
      });
    });

    it("answers 404 for the storage of an environment the caller can't see", async () => {
      for (const [id, role] of [
        [ENGINEER, "engineer"],
        [QA, "qa"],
      ] as const) {
        as(id, role);
        expect(
          await refusal(explorer.listEntries(src(ENV_B), ""))
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(explorer.deleteEntry(src(ENV_B), "a.txt"))
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(explorer.getDownloadTarget(src(ENV_B), "a.txt"))
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(explorer.listEntries(src(MISSING), ""))
        ).toMatchObject({ status: 404 });
      }
      const download = await app.request(
        `/api/explorer/download?source=${encodeURIComponent(
          JSON.stringify(src(ENV_B))
        )}&path=a.txt`
      );
      expect(download.status).toBe(404);
      const archive = await app.request(
        `/api/explorer/archive?source=${encodeURIComponent(
          JSON.stringify(src(ENV_B))
        )}`
      );
      expect(archive.status).toBe(404);
      const form = new FormData();
      form.set("file", new File(["x"], "a.txt"));
      form.set("source", JSON.stringify(src(ENV_B)));
      form.set("path", "");
      const upload = await app.request("/api/explorer/upload", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
        body: form,
      });
      expect(upload.status).toBe(404);
      expect(s3.opened).toEqual([]);
    });

    it("refuses a QA upload into a visible environment's bucket", async () => {
      as(QA, "qa");
      const form = new FormData();
      form.set("file", new File(["x"], "a.txt"));
      form.set("source", JSON.stringify(src(ENV_A)));
      form.set("path", "");
      const upload = await app.request("/api/explorer/upload", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
        body: form,
      });
      expect(upload.status).toBe(403);
      expect(s3.opened).toEqual([]);
    });

    it("answers 404 for an environment without storage, to admins too", async () => {
      for (const [id, role] of [
        [ENGINEER, "engineer"],
        [ADMIN, "admin"],
      ] as const) {
        as(id, role);
        expect(
          await refusal(explorer.listEntries(src(ENV_A2), ""))
        ).toMatchObject({ status: 404 });
      }
      expect(s3.opened).toEqual([]);
    });

    it("logs a file action against the environment", async () => {
      as(ENGINEER, "engineer");
      await explorer.deleteEntry(src(ENV_A), "a.txt");
      const rows = await sql<
        { entity_type: string; entity_id: string; data: { target: string } }[]
      >`select entity_type, entity_id, data from activity_log
        where action = 'files.delete'`;
      expect(rows).toEqual([
        expect.objectContaining({
          entity_type: "environment",
          entity_id: ENV_A,
        }),
      ]);
      expect(rows[0]?.data.target).toContain("Kestrel");
    });

    it("needs a strong sign-in to browse", async () => {
      as(ENGINEER, "engineer", "password");
      expect(await refusal(explorer.listEntries(src(ENV_A), ""))).toMatchObject(
        { status: 403, code: "strong_sign_in_required" }
      );
      expect(s3.opened).toEqual([]);
    });
  });
});
