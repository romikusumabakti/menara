import { beforeEach, describe, expect, it, vi } from "vitest";

// The file explorer addresses object storage by environment
// ({ kind: "s3", environmentId }): it opens the environment's one storage
// (environment_storage), takes that environment's rights
// (ENVIRONMENT_STORAGE_RIGHTS: read = variable:read, write =
// environment:update, both with a strong sign-in), keeps a storage that
// reaches into the instance backup destination to the org role's own
// `storage:files`, and logs file actions against the environment. The
// database is a fake that answers by table; the S3 backend is a fake that
// records what it was opened with.

const ENV_A = "0197f3a0-1b2c-7def-8000-0000000000e1";
// In p1 too, but nothing configured.
const ENV_EMPTY = "0197f3a0-1b2c-7def-8000-0000000000e2";
// In p1, its storage on the backup destination's bucket.
const ENV_RESTRICTED = "0197f3a0-1b2c-7def-8000-0000000000e3";
// In p2, a project the members below don't see.
const ENV_OTHER = "0197f3a0-1b2c-7def-8000-0000000000e4";
// In p2 too, its storage on the backup destination's bucket.
const ENV_OTHER_RESTRICTED = "0197f3a0-1b2c-7def-8000-0000000000e5";

const state = vi.hoisted(() => ({
  session: {
    user: { id: "u1", role: "qa" },
    session: { signInMethod: "passkey" },
  },
  memberships: [] as { projectId: string }[],
  activity: [] as Record<string, unknown>[],
  opened: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  let lastWhere: unknown;
  const answer = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    const self = () => Object.assign(Promise.resolve(rows()), q);
    q.where = (condition: unknown) => {
      lastWhere = condition;
      return self();
    };
    q.innerJoin = () => self();
    q.limit = async () => rows().slice(0, 1);
    q.orderBy = async () => rows();
    return self();
  };
  // The uuid a where(eq(column, id)) compares against (cyclic SQL tree).
  const whereId = () => {
    const seen = new Set<unknown>();
    const walk = (node: unknown): string | undefined => {
      if (typeof node === "string") {
        return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(node) ? node : undefined;
      }
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      for (const value of Object.values(node)) {
        const found = walk(value);
        if (found) return found;
      }
    };
    return walk(lastWhere);
  };
  const storage = (environmentId: string, bucket: string) => ({
    environmentId,
    endpoint: "https://objects.example.test",
    region: "us-east-1",
    bucket,
    keyPrefix: "team-a/",
    accessKeyId: "AKFICTIONAL",
    secretKey: "fictional-secret",
    forcePathStyle: true,
  });
  const environments: Record<string, { projectId: string; name: string }> = {
    [ENV_A]: { projectId: "p1", name: "Dev" },
    [ENV_EMPTY]: { projectId: "p1", name: "QA" },
    [ENV_RESTRICTED]: { projectId: "p1", name: "Ops" },
    [ENV_OTHER]: { projectId: "p2", name: "Prod" },
    [ENV_OTHER_RESTRICTED]: { projectId: "p2", name: "Ops" },
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.projects) {
            return answer(() => [{ id: "p1" }, { id: "p2" }]);
          }
          if (table === schema.environmentStorage) {
            return answer(() => {
              // The row as Postgres returns it: its id in canonical form.
              const id = whereId()?.toLowerCase();
              if (id === ENV_A) return [storage(ENV_A, "acme-files")];
              if (id === ENV_OTHER) return [storage(ENV_OTHER, "beta-files")];
              if (id === ENV_RESTRICTED) {
                return [storage(ENV_RESTRICTED, "acme-backups")];
              }
              if (id === ENV_OTHER_RESTRICTED) {
                return [storage(ENV_OTHER_RESTRICTED, "acme-backups")];
              }
              return [];
            });
          }
          if (table === schema.s3Connections) {
            throw new Error("the explorer no longer reads s3_connections");
          }
          if (table === schema.environments) {
            return answer(() => {
              const id = whereId()?.toLowerCase();
              const env = id ? environments[id] : undefined;
              return env ? [{ ...env, projectName: "ACME" }] : [];
            });
          }
          if (table === schema.projectMembers) {
            return answer(() => state.memberships);
          }
          if (table === schema.instanceSettings) {
            return answer(() => [
              {
                legacyId: null,
                endpoint: "https://other.example.test",
                bucket: "acme-backups",
                keyPrefix: null,
              },
            ]);
          }
          throw new Error("unexpected table");
        },
      }),
    },
    pgClient: vi.fn(),
  };
});
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => state.session,
  getServerSession: async () => state.session,
}));
vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (entry: Record<string, unknown>) => {
    state.activity.push(entry);
  }),
}));
vi.mock("@/lib/explorer/s3", () => ({
  createS3Backend: (config: Record<string, unknown>) => {
    state.opened.push(config);
    return { list: async () => [], remove: async () => {} };
  },
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const { app } = await import("@/server/app");
const { ENVIRONMENT_STORAGE_RIGHTS } = await import("@/lib/restricted-targets");
const { deleteEntry, listEntries } = await import("@/server/services/explorer");

const s3 = (environmentId: string) => ({ kind: "s3", environmentId }) as const;

function as(role: string, signInMethod: string, ...projectIds: string[]) {
  state.session = { user: { id: "u1", role }, session: { signInMethod } };
  state.memberships = projectIds.map((projectId) => ({ projectId }));
}

const download = (source: unknown) =>
  app.request(
    `/api/explorer/download?source=${encodeURIComponent(JSON.stringify(source))}&path=a.txt`
  );

beforeEach(() => {
  state.activity = [];
  state.opened = [];
});

describe("explorer on an environment's storage", () => {
  it("states the environment rights by intent", () => {
    expect(ENVIRONMENT_STORAGE_RIGHTS).toEqual({
      read: { variable: ["read"] },
      write: { environment: ["update"] },
    });
  });

  it("owned env: read needs variable:read, write needs environment:update + strong sign-in", async () => {
    as("qa", "passkey", "p1");
    await expect(listEntries(s3(ENV_A), "")).rejects.toMatchObject({
      status: 403,
    });
    await expect(deleteEntry(s3(ENV_A), "a.txt")).rejects.toMatchObject({
      status: 403,
    });
    expect(state.opened).toEqual([]);

    as("engineer", "password", "p1");
    await expect(deleteEntry(s3(ENV_A), "a.txt")).rejects.toMatchObject({
      status: 403,
      code: "strong_sign_in_required",
    });
    expect(state.opened).toEqual([]);

    as("engineer", "passkey", "p1");
    expect(await listEntries(s3(ENV_A), "")).toEqual({
      success: true,
      data: [],
    });
    expect(await deleteEntry(s3(ENV_A), "a.txt")).toMatchObject({
      success: true,
    });
    // The environment's storage, its secret decrypted server-side.
    expect(state.opened[0]).toMatchObject({
      bucket: "acme-files",
      keyPrefix: "team-a/",
      secretKey: "fictional-secret",
    });
  });

  it("logs file actions against the environment", async () => {
    as("engineer", "passkey", "p1");
    await deleteEntry(s3(ENV_A), "a.txt");
    expect(state.activity).toEqual([
      expect.objectContaining({
        action: "files.delete",
        entityType: "environment",
        entityId: ENV_A,
        data: { target: "ACME · Dev", path: "a.txt" },
      }),
    ]);
  });

  it("env without storage → 404", async () => {
    as("engineer", "passkey", "p1");
    await expect(listEntries(s3(ENV_EMPTY), "")).rejects.toMatchObject({
      status: 404,
    });
    expect((await download(s3(ENV_EMPTY))).status).toBe(404);
    as("admin", "passkey");
    await expect(listEntries(s3(ENV_EMPTY), "")).rejects.toMatchObject({
      status: 404,
    });
    expect(state.opened).toEqual([]);
  });

  it("answers 404 for an environment the caller can't see", async () => {
    for (const role of ["engineer", "qa"]) {
      as(role, "passkey", "p1");
      await expect(listEntries(s3(ENV_OTHER), "")).rejects.toMatchObject({
        status: 404,
      });
      expect((await download(s3(ENV_OTHER))).status).toBe(404);
    }
    expect(state.opened).toEqual([]);
  });

  it("answers 404, not the restricted 403, for a restricted storage the caller can't see", async () => {
    for (const role of ["engineer", "qa"]) {
      as(role, "passkey", "p1");
      for (const call of [
        () => listEntries(s3(ENV_OTHER_RESTRICTED), ""),
        () => deleteEntry(s3(ENV_OTHER_RESTRICTED), "a.txt"),
      ]) {
        await expect(call(), role).rejects.toMatchObject({ status: 404 });
      }
      expect((await download(s3(ENV_OTHER_RESTRICTED))).status, role).toBe(404);
    }
    expect(state.opened).toEqual([]);
  });

  it("restricted source needs storage:files", async () => {
    as("engineer", "passkey", "p1");
    await expect(listEntries(s3(ENV_RESTRICTED), "")).rejects.toMatchObject({
      status: 403,
    });
    // Whatever the id's case: the lookup is by uuid.
    await expect(
      listEntries(s3(ENV_RESTRICTED.toUpperCase()), "")
    ).rejects.toMatchObject({ status: 403 });
    expect((await download(s3(ENV_RESTRICTED))).status).toBe(403);
    expect(state.opened).toEqual([]);

    as("infra", "passkey");
    expect(await listEntries(s3(ENV_RESTRICTED), "")).toEqual({
      success: true,
      data: [],
    });
    expect(state.opened).toHaveLength(1);
  });

  it("refuses the old connection-addressed source as invalid input", async () => {
    as("engineer", "passkey", "p1");
    expect(
      await listEntries({ kind: "s3", connectionId: ENV_A }, "")
    ).toMatchObject({ success: false, message: "invalidInput" });
    expect(state.opened).toEqual([]);
  });
});
