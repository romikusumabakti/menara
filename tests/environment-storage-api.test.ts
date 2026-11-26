import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

// One object storage per environment (environment_storage, 1:1): get, save
// (upsert), remove and test, with the secret rules (never returned; reused
// only for the stored location), the backup-destination refusals, the
// rights (view = project read; writes = environment:update + a strong
// sign-in) and the activity entries. While the old s3_connections table
// still exists (expand/contract), every save, remove and environment delete
// drains that environment's rows from it in the same transaction (deletes
// the unreferenced ones, detaches the rest; which is which is the scratch
// suite's, on a real database). The
// database is a recording fake: each statement is kept with its table, its
// rendered WHERE and whether it ran inside a transaction.

const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";
const ACTOR = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SECRET = "fictional-secret-7f3c";

const state = vi.hoisted(() => ({
  role: "engineer" as string | null,
  orgRole: "admin",
  signInMethod: "passkey",
  // The environment_storage row (secretKey as stored: "enc:<secret>").
  storage: null as Record<string, unknown> | null,
  // The instance backup destination's bucket (overlap = same bucket).
  backupBucket: "acme-backups" as string | null,
  // Rows an environments DELETE … RETURNING yields.
  environmentDeleted: [{ name: "Dev" }] as { name: string }[],
  probes: [] as Record<string, unknown>[],
  probeResult: { ok: true } as { ok: true } | { ok: false; message: string },
  activity: [] as Record<string, unknown>[],
  // Whether a transaction callback threw (the real one then rolls back).
  rolledBack: false,
  ops: [] as {
    kind: string;
    table: unknown;
    where?: unknown;
    values?: unknown;
    set?: unknown;
    fields?: Record<string, unknown>;
    inTx: boolean;
  }[],
}));

vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: { id: ACTOR, role: state.orgRole, name: "Admin" },
    session: { signInMethod: state.signInMethod },
  });
  return { requireSession: current, getServerSession: current };
});
vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  const { canProject } = await import("@/lib/permissions");
  return {
    ...real,
    getProjectRole: async () => state.role,
    requireProjectPermission: async (
      _scope: unknown,
      perms: Parameters<typeof canProject>[1]
    ) => {
      if (!state.role) throw new HTTPException(404);
      if (!canProject(state.role as never, perms)) {
        throw new real.ForbiddenError();
      }
      return {
        session: {
          user: { id: ACTOR, role: state.orgRole },
          session: { signInMethod: state.signInMethod },
        },
        role: state.role,
        projectId: "0197f3a0-1b2c-7def-8000-0123456789f1",
      };
    },
  };
});
vi.mock("@/lib/access-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-scope")>()),
  accessScopeFromSession: async () => ({
    userId: ACTOR,
    orgRole: "admin",
    projectRoles: {},
    seesAllProjects: true,
  }),
}));
vi.mock("@/lib/activity", () => ({
  recordActivity: async (entry: Record<string, unknown>) => {
    state.activity.push(entry);
  },
}));
vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  environmentName: async () => "ACME / Dev",
}));
vi.mock("@/lib/secrets", () => ({
  encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => value.replace(/^enc:/, ""),
  encryptNullable: (value: string | null | undefined) => value ?? null,
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));
vi.mock("@/lib/explorer/s3", () => ({
  testS3Connection: async (probe: Record<string, unknown>) => {
    state.probes.push(probe);
    return state.probeResult;
  },
}));
vi.mock("@/lib/restricted-targets", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/restricted-targets")>();
  return {
    ...real,
    overlapsBackupDestination: async (location: { bucket: string }) =>
      state.backupBucket !== null && location.bucket === state.backupBucket,
  };
});
// The environment delete paths: no teardown under way.
vi.mock("@/lib/teardown/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teardown/guard")>()),
  tearingDownIn: async () => false,
  holdEnvironmentExclusive: async () => {},
}));
vi.mock("@/lib/teardown/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teardown/repository")>()),
  teardownState: async () => ({
    planned: false,
    running: false,
    progressed: false,
  }),
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  type Op = (typeof state.ops)[number];
  const rowsOf = (op: Op): unknown[] => {
    if (op.table === schema.environmentStorage) {
      if (op.kind === "select") return state.storage ? [state.storage] : [];
      if (op.kind === "insert") {
        const values = op.values as Record<string, unknown>;
        const conflict = op.set as Record<string, unknown> | undefined;
        state.storage = state.storage
          ? { ...state.storage, ...conflict }
          : {
              region: "us-east-1",
              keyPrefix: null,
              forcePathStyle: true,
              createdAt: new Date(0),
              updatedAt: new Date(0),
              ...values,
            };
        return [state.storage];
      }
      if (op.kind === "delete") {
        const removed = state.storage;
        state.storage = null;
        return removed ? [removed] : [];
      }
    }
    if (op.table === schema.environments && op.kind === "delete") {
      return state.environmentDeleted;
    }
    if (op.table === schema.environments && op.kind === "select") {
      return state.environmentDeleted.length > 0 ? [] : [{ id: ENV }];
    }
    return [];
  };
  const builder = (inTx: boolean) => {
    const start = (kind: string, table?: unknown, fields?: unknown) => {
      const op: Op = {
        kind,
        table,
        inTx,
        fields: fields as Record<string, unknown>,
      };
      state.ops.push(op);
      // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
      const chain: any = {
        from: (t: unknown) => {
          op.table = t;
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: (where: unknown) => {
          op.where = where;
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        for: () => chain,
        values: (values: unknown) => {
          op.values = values;
          return chain;
        },
        set: (set: unknown) => {
          op.set = set;
          return chain;
        },
        onConflictDoUpdate: (config: { set: unknown }) => {
          op.set = config.set;
          return chain;
        },
        onConflictDoNothing: () => chain,
        union: () => chain,
        returning: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: awaitable query builder
        then: (resolve: (rows: unknown[]) => unknown, reject: () => unknown) =>
          Promise.resolve()
            .then(() => rowsOf(op))
            .then(resolve, reject),
      };
      return chain;
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake drizzle surface
    const db: any = {
      select: (fields?: unknown) => start("select", undefined, fields),
      insert: (table: unknown) => start("insert", table),
      update: (table: unknown) => start("update", table),
      delete: (table: unknown) => start("delete", table),
      execute: async () => [],
      transaction: async (fn: (tx: unknown) => unknown) => {
        try {
          return await fn(builder(true));
        } catch (error) {
          state.rolledBack = true;
          throw error;
        }
      },
    };
    return db;
  };
  return { db: builder(false) };
});

const schema = await import("@/lib/db/schema");
const storage = await import("@/server/services/environment-storage");
const { environmentStorageRouter } = await import(
  "@/server/routes/environment-storage"
);
const { deleteEnvironment, listEnvironmentsFor } = await import(
  "@/server/services/environments"
);
const { deleteTeardownEnvironment } = await import("@/lib/teardown/repository");

const dialect = new PgDialect();
const render = (where: unknown) => dialect.sqlToQuery(where as SQL);

// The location a form sends.
const input = (overrides: Record<string, unknown> = {}) => ({
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "acme-app",
  accessKeyId: "AKIAEXAMPLE",
  forcePathStyle: true,
  keyPrefix: null,
  ...overrides,
});

const storedRow = (overrides: Record<string, unknown> = {}) => ({
  environmentId: ENV,
  ...input(),
  secretKey: `enc:${SECRET}`,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

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

const drains = () =>
  state.ops.filter(
    (op) => op.kind === "delete" && op.table === schema.s3Connections
  );
// The rows the drain keeps (an archive or the legacy backup setting names
// them): detached, environment_id set null.
const detaches = () =>
  state.ops.filter(
    (op) => op.kind === "update" && op.table === schema.s3Connections
  );
// The environment a drain statement is aimed at (the fake's subqueries
// render as opaque params; only the bound id is a string).
const aimedAt = (op: (typeof state.ops)[number] | undefined) =>
  render(op?.where).params.filter((p) => typeof p === "string");
// Both drain statements: in the transaction, aimed at ENV, before `before`.
const expectDrained = (before = state.ops.length) => {
  const drain = state.ops.findIndex((op) => drains().includes(op));
  const detach = state.ops.findIndex((op) => detaches().includes(op));
  expect(drain).toBeGreaterThanOrEqual(0);
  expect(detach).toBeGreaterThan(drain);
  expect(detach).toBeLessThan(before);
  for (const op of [state.ops[drain], state.ops[detach]]) {
    expect(op?.inTx).toBe(true);
    expect(aimedAt(op)).toEqual([ENV]);
  }
  expect(state.ops[detach]?.set).toEqual({ environmentId: null });
};

beforeEach(() => {
  state.role = "engineer";
  state.orgRole = "admin";
  state.signInMethod = "passkey";
  state.storage = null;
  state.backupBucket = "acme-backups";
  state.environmentDeleted = [{ name: "Dev" }];
  state.probes = [];
  state.probeResult = { ok: true };
  state.activity = [];
  state.ops = [];
  state.rolledBack = false;
});

describe("getEnvironmentStorage", () => {
  it("get returns null when unset", async () => {
    expect(await storage.getEnvironmentStorage(ENV)).toBeNull();
  });

  it("get never returns the secret", async () => {
    state.storage = storedRow();
    const got = await storage.getEnvironmentStorage(ENV);
    expect(got).toMatchObject({
      environmentId: ENV,
      bucket: "acme-app",
      hasSecret: true,
      isBackupDestination: false,
    });
    expect(got).not.toHaveProperty("secretKey");
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });

  it("marks a stored config inside the backup destination", async () => {
    state.storage = storedRow({ bucket: "acme-backups" });
    expect(await storage.getEnvironmentStorage(ENV)).toMatchObject({
      isBackupDestination: true,
    });
  });
});

describe("saveEnvironmentStorage", () => {
  it("save upserts and drains old connection rows", async () => {
    const saved = await storage.saveEnvironmentStorage(
      ENV,
      input({ secretKey: SECRET, keyPrefix: "/team-a" })
    );
    expect(saved).toMatchObject({
      environmentId: ENV,
      keyPrefix: "team-a/",
      hasSecret: true,
    });
    expect(saved).not.toHaveProperty("secretKey");
    expect(state.storage).toMatchObject({ secretKey: `enc:${SECRET}` });
    const upsert = state.ops.find(
      (op) => op.kind === "insert" && op.table === schema.environmentStorage
    );
    expect(upsert?.inTx).toBe(true);
    expect(upsert?.set).toBeDefined();
    expectDrained();

    // A second save (same location, no secret) updates the same row and
    // keeps the stored secret.
    await storage.saveEnvironmentStorage(
      ENV,
      input({ keyPrefix: "team-a/", forcePathStyle: true })
    );
    expect(state.storage).toMatchObject({
      keyPrefix: "team-a/",
      secretKey: `enc:${SECRET}`,
    });
    expect(drains()).toHaveLength(2);
  });

  it("location change requires secret", async () => {
    state.storage = storedRow();
    for (const change of [
      { bucket: "acme-other" },
      { endpoint: "https://evil.example.com" },
      { keyPrefix: "other/" },
      { accessKeyId: "AKIAOTHER" },
      { forcePathStyle: false },
      { region: "eu-west-1" },
    ]) {
      expect(
        await refusal(storage.saveEnvironmentStorage(ENV, input(change)))
      ).toEqual({ status: 400, code: "s3SecretRequiredForLocationChange" });
    }
    // An empty secret is "keep the stored one", not a new one.
    expect(
      await refusal(
        storage.saveEnvironmentStorage(
          ENV,
          input({ bucket: "acme-other", secretKey: "" })
        )
      )
    ).toEqual({ status: 400, code: "s3SecretRequiredForLocationChange" });
    expect(state.storage).toMatchObject({ bucket: "acme-app" });
    // With a new secret the move is fine.
    await storage.saveEnvironmentStorage(
      ENV,
      input({ bucket: "acme-other", secretKey: "fictional-secret-new" })
    );
    expect(state.storage).toMatchObject({
      bucket: "acme-other",
      secretKey: "enc:fictional-secret-new",
    });
  });

  it("a first save needs a secret", async () => {
    expect(await refusal(storage.saveEnvironmentStorage(ENV, input()))).toEqual(
      { status: 400, code: "s3SecretRequiredForLocationChange" }
    );
    expect(state.storage).toBeNull();
  });

  it("refuses a bad key prefix with its code", async () => {
    expect(
      await refusal(
        storage.saveEnvironmentStorage(
          ENV,
          input({ secretKey: SECRET, keyPrefix: "a/../b/" })
        )
      )
    ).toEqual({ status: 400, code: "s3KeyPrefixInvalid" });
  });

  it("save refuses backup-destination overlap", async () => {
    expect(
      await refusal(
        storage.saveEnvironmentStorage(
          ENV,
          input({ bucket: "acme-backups", secretKey: SECRET })
        )
      )
    ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
    expect(state.storage).toBeNull();
    expect(drains()).toHaveLength(0);
  });

  it("replaces a restricted config with one outside the backup destination", async () => {
    state.storage = storedRow({ bucket: "acme-backups" });
    await storage.saveEnvironmentStorage(
      ENV,
      input({ bucket: "acme-app", secretKey: "fictional-secret-new" })
    );
    expect(state.storage).toMatchObject({ bucket: "acme-app" });
  });
});

describe("testEnvironmentStorage", () => {
  it("test reuses stored secret when the location is unchanged", async () => {
    state.storage = storedRow();
    expect(await storage.testEnvironmentStorage(ENV, input())).toEqual({
      ok: true,
    });
    expect(state.probes).toEqual([{ ...input(), secretKey: SECRET }]);
  });

  it("test with a moved location needs the secret again", async () => {
    state.storage = storedRow();
    expect(
      await refusal(
        storage.testEnvironmentStorage(
          ENV,
          input({ endpoint: "https://evil.example.com" })
        )
      )
    ).toEqual({ status: 400, code: "s3SecretRequiredForLocationChange" });
    expect(state.probes).toEqual([]);
  });

  it("test uses a typed secret, and answers coded failures", async () => {
    expect(await storage.testEnvironmentStorage(ENV, input())).toEqual({
      ok: false,
      code: "s3SecretRequiredForTest",
    });
    state.probeResult = { ok: false, message: "NoSuchBucket" };
    expect(
      await storage.testEnvironmentStorage(
        ENV,
        input({ secretKey: "fictional-typed" })
      )
    ).toEqual({ ok: false, code: "s3ProbeFailed", message: "NoSuchBucket" });
    expect(state.probes).toEqual([
      { ...input(), secretKey: "fictional-typed" },
    ]);
  });
});

describe("restricted config", () => {
  it("restricted config: delete ok, test refused", async () => {
    state.storage = storedRow({ bucket: "acme-backups" });
    expect(
      await refusal(
        storage.testEnvironmentStorage(ENV, input({ bucket: "acme-backups" }))
      )
    ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
    expect(state.probes).toEqual([]);
    await storage.removeEnvironmentStorage(ENV);
    expect(state.storage).toBeNull();
  });
});

describe("removeEnvironmentStorage", () => {
  it("removes the row and drains old connection rows in one transaction", async () => {
    state.storage = storedRow();
    await storage.removeEnvironmentStorage(ENV);
    expect(state.storage).toBeNull();
    const remove = state.ops.find(
      (op) => op.kind === "delete" && op.table === schema.environmentStorage
    );
    expect(remove?.inTx).toBe(true);
    expectDrained();
  });

  it("removing nothing records nothing", async () => {
    await storage.removeEnvironmentStorage(ENV);
    expect(state.activity).toEqual([]);
  });
});

describe("rights", () => {
  it("writes need environment:update and a strong session", async () => {
    // QA sees the environment but may not edit its settings.
    state.role = "qa";
    state.storage = storedRow();
    expect(await storage.getEnvironmentStorage(ENV)).toMatchObject({
      hasSecret: true,
    });
    for (const call of [
      () => storage.saveEnvironmentStorage(ENV, input({ secretKey: SECRET })),
      () => storage.removeEnvironmentStorage(ENV),
      () => storage.testEnvironmentStorage(ENV, input()),
    ]) {
      expect((await refusal(call())).status).toBe(403);
    }

    // An engineer with a password-only sign-in: the strong sign-in refusal.
    state.role = "engineer";
    state.signInMethod = "password";
    for (const call of [
      () => storage.saveEnvironmentStorage(ENV, input({ secretKey: SECRET })),
      () => storage.removeEnvironmentStorage(ENV),
      () => storage.testEnvironmentStorage(ENV, input()),
    ]) {
      expect(await refusal(call())).toEqual({
        status: 403,
        code: "strong_sign_in_required",
      });
    }
    expect(state.storage).toMatchObject({ bucket: "acme-app" });
    expect(state.probes).toEqual([]);
    expect(drains()).toHaveLength(0);
  });

  it("read needs project read (an environment the caller can't see is a 404)", async () => {
    state.role = null;
    expect((await refusal(storage.getEnvironmentStorage(ENV))).status).toBe(
      404
    );
  });
});

describe("activity", () => {
  it("activity records storage.configured / storage.removed with field names only", async () => {
    await storage.saveEnvironmentStorage(ENV, input({ secretKey: SECRET }));
    await storage.saveEnvironmentStorage(
      ENV,
      input({ region: "eu-west-1", secretKey: "fictional-secret-new" })
    );
    // Nothing changed and no new secret: saved, but no activity entry.
    await storage.saveEnvironmentStorage(ENV, input({ region: "eu-west-1" }));
    await storage.removeEnvironmentStorage(ENV);
    expect(state.activity).toEqual([
      {
        actorId: ACTOR,
        action: "storage.configured",
        entityType: "environment",
        entityId: ENV,
        data: {
          environment: "ACME / Dev",
          fields:
            "endpoint, region, bucket, keyPrefix, accessKeyId, forcePathStyle, secretKey",
        },
      },
      {
        actorId: ACTOR,
        action: "storage.configured",
        entityType: "environment",
        entityId: ENV,
        data: { environment: "ACME / Dev", fields: "region, secretKey" },
      },
      {
        actorId: ACTOR,
        action: "storage.removed",
        entityType: "environment",
        entityId: ENV,
        data: { environment: "ACME / Dev" },
      },
    ]);
    const logged = JSON.stringify(state.activity);
    for (const value of [
      SECRET,
      "fictional-secret-new",
      "s3.example.com",
      "acme-app",
      "AKIAEXAMPLE",
    ]) {
      expect(logged).not.toContain(value);
    }
  });
});

describe("environment delete", () => {
  it("environment delete drains old connection rows (row-only delete)", async () => {
    expect(await deleteEnvironment(ENV)).toMatchObject({ success: true });
    const envDelete = state.ops.findIndex(
      (op) => op.kind === "delete" && op.table === schema.environments
    );
    // Before the row goes (its FK would null environment_id), same transaction.
    expectDrained(envDelete);
  });

  it("a row-only delete refused by a late escrow keeps the old rows (rolled back)", async () => {
    state.environmentDeleted = [];
    await expect(deleteEnvironment(ENV)).rejects.toMatchObject({
      status: 409,
    });
    expect(drains()).toHaveLength(1);
    expect(state.rolledBack).toBe(true);
  });

  it("environment delete drains old connection rows (teardown delete)", async () => {
    expect(
      await deleteTeardownEnvironment(ENV, ACTOR, { escrowConfirmed: true })
    ).toMatchObject({ environmentName: "Dev" });
    const envDelete = state.ops.findIndex(
      (op) => op.kind === "delete" && op.table === schema.environments
    );
    expectDrained(envDelete);
  });

  it("a teardown delete refused by escrow keeps the old rows (rolled back)", async () => {
    state.environmentDeleted = [];
    expect(
      await deleteTeardownEnvironment(ENV, ACTOR, { escrowConfirmed: false })
    ).toEqual({ refusal: "environmentHasEscrowedVariables" });
    expect(drains()).toHaveLength(1);
    expect(state.rolledBack).toBe(true);
  });
});

describe("listEnvironments", () => {
  it("listEnvironments exposes hasStorage", async () => {
    await listEnvironmentsFor({
      userId: ACTOR,
      orgRole: "admin",
      projectRoles: {},
      seesAllProjects: true,
    } as never);
    const list = state.ops.find(
      (op) => op.kind === "select" && op.fields && "hasMailpit" in op.fields
    );
    const hasStorage = list?.fields?.hasStorage;
    expect(hasStorage).toBeDefined();
    const { sql } = render(hasStorage);
    expect(sql).toContain('"environment_storage"');
    expect(sql).toContain("exists");
    // EXISTS only: no storage column (the secret) enters the projection.
    expect(Object.keys(list?.fields ?? {})).not.toContain("secretKey");
  });
});

describe("routes", () => {
  const request = (path: string, init?: RequestInit) =>
    environmentStorageRouter.request(path, init);

  it("GET answers null when unset, the safe row when set", async () => {
    const empty = await request(`/${ENV}/storage`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toBeNull();
    state.storage = storedRow();
    const set = await request(`/${ENV}/storage`);
    const body = await set.json();
    expect(body).toMatchObject({ hasSecret: true });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("PUT saves, POST test probes, DELETE removes", async () => {
    const put = await request(`/${ENV}/storage`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input({ secretKey: SECRET })),
    });
    expect(put.status).toBe(200);
    expect(state.storage).toMatchObject({ bucket: "acme-app" });
    const probe = await request(`/${ENV}/storage/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect(await probe.json()).toEqual({ ok: true });
    const remove = await request(`/${ENV}/storage`, { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect(state.storage).toBeNull();
  });

  it("the per-connection routes are gone", async () => {
    const id = "0197f3a0-1b2c-7def-8000-0123456789c1";
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const res = await request(`/${ENV}/storage/${id}`, { method });
      expect(res.status).toBe(404);
    }
    const post = await request(`/${ENV}/storage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input({ secretKey: SECRET }), name: "x" }),
    });
    expect(post.status).toBe(404);
  });
});
