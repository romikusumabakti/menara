import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, type Row } from "./support/remark-db";

// The assistant-logins step: the rename runs through the per-engine
// provisioning path against a fake database server (a set of login names
// reached over a faked executeRemoteCommand); the login proof and password
// reset is the existing enable path, faked here as a spy.

const ENV = "0197f3a0-1b2c-7def-8000-0000000e0001";
const SVC = "0197f3a0-1b2c-7def-8000-0000000c0001";
const SRV = "0197f3a0-1b2c-7def-8000-0000000000a1";
const ADMIN_PW = "fictional-admin-Pw-31";
const RO_PW = "FictionalReadOnlyPw0123456789abc";
const OLD = "oldtool_ro_kestrel_qa";
const NEW = "menara_ro_kestrel_qa";

vi.mock("drizzle-orm", async (importOriginal) => {
  const { fakeDrizzleOperators } = await import("./support/remark-db");
  return fakeDrizzleOperators(importOriginal);
});

const state = vi.hoisted(() => ({
  logins: new Set<string>(),
  calls: [] as { command: string; stdin: string }[],
  enable: [] as { ownLogin: string | null; password: string | null }[],
  enableFails: false,
  enableReturns: null as string | null | undefined,
  service: {} as Record<string, unknown>,
}));

vi.mock("@/lib/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ssh")>()),
  executeRemoteCommand: async (
    _target: unknown,
    command: string,
    opts: { stdin?: string } = {}
  ) => {
    const stdin = opts.stdin ?? "";
    state.calls.push({ command, stdin });
    const text = `${command}\n${stdin}`;
    if (text.includes("mysql.user")) {
      return [OLD, NEW].filter((l) => state.logins.has(l)).join("\n");
    }
    if (/RENAME TO|RENAME USER|WITH NAME/.test(text)) {
      if (state.logins.has(OLD) && state.logins.has(NEW)) {
        throw new Error("both exist");
      }
      if (state.logins.has(OLD)) {
        state.logins.delete(OLD);
        state.logins.add(NEW);
      } else if (!state.logins.has(NEW)) {
        // What the rename scripts raise when neither name exists.
        throw new Error("ERROR:  menara-assistant-login-missing: not found");
      }
      return "";
    }
    throw new Error(`unexpected command: ${command}`);
  },
}));

vi.mock("@/lib/assistant-db/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant-db/provision")>()),
  enableAssistantDbLogin: async (
    _service: unknown,
    opts: { ownLogin: string | null; password: string | null }
  ) => {
    state.enable.push({ ownLogin: opts.ownLogin, password: opts.password });
    if (state.enableFails) throw new Error("Login cannot log in");
    return {
      login: opts.ownLogin,
      password:
        state.enableReturns === undefined ? opts.password : state.enableReturns,
    };
  },
}));

vi.mock("@/lib/environments", () => ({
  loadEnvironmentWithServers: async (id: string) =>
    id === ENV
      ? { id, name: "kestrel-qa", services: [{ ...state.service, role: "db" }] }
      : null,
}));

vi.mock("@/lib/teardown/guard", () => ({
  tearingDownIn: async () => false,
}));

vi.mock("@/lib/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets")>()),
  encryptNullable: (v: string | null) => (v === null ? null : `enc:${v}`),
}));

const step = await import("@/lib/remark/assistant-logins");
const { pgRenameAssistantDbSql, mssqlRenameAssistantDbSql } = await import(
  "@/lib/assistant-db/provision"
);

const LEGACY: Legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};

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

type Engine = "postgres" | "mysql" | "mssql";

function setup(engine: Engine, over: Row = {}) {
  const row: Row = {
    id: SVC,
    environmentId: ENV,
    role: "db",
    serverId: SRV,
    serviceType: "docker",
    serviceName: "kestrel-db",
    dbType: engine,
    dbName: "kestrel_qa",
    dbUser: null,
    dbPassword: engine === "postgres" ? null : ADMIN_PW,
    dbKind: "container",
    dbRole: null,
    databaseHostId: null,
    assistantDbEnabled: true,
    assistantDbLogin: OLD,
    assistantDbPassword: engine === "postgres" ? null : `enc:${RO_PW}`,
    ...over,
  };
  tables.environment_services = [row];
  state.service = {
    ...row,
    // As loadEnvironmentWithServers returns it: decrypted.
    assistantDbPassword: engine === "postgres" ? null : RO_PW,
    server: {
      id: SRV,
      host: "10.0.0.20",
      username: "root",
      password: null,
      auth: "key",
    },
  };
  state.logins = new Set([OLD]);
}

beforeEach(() => {
  vi.stubEnv("MENARA_LEGACY_NAME", "oldtool");
  state.calls = [];
  state.enable = [];
  state.enableFails = false;
  state.enableReturns = undefined;
  errors = [];
  tables = {};
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("remark assistant-logins", () => {
  it("plans nothing without legacy data", async () => {
    setup("postgres", { assistantDbLogin: NEW });
    tables.environment_services?.push({
      ...tables.environment_services[0],
      id: "other",
      assistantDbLogin: null,
    });
    expect(await step.plan(ctx())).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    setup("mysql");
    expect(await step.plan(ctx())).toEqual([
      {
        step: "assistant-logins",
        target: `services/${SVC}`,
        from: OLD,
        to: NEW,
      },
    ]);
  });

  for (const engine of ["postgres", "mysql", "mssql"] as const) {
    it(`apply converts it (${engine})`, async () => {
      setup(engine);
      const [item] = await step.plan(ctx());
      if (!item) throw new Error("no item");
      await step.apply(ctx(), item);
      expect([...state.logins]).toEqual([NEW]);
      expect(tables.environment_services?.[0]?.assistantDbLogin).toBe(NEW);
      // Proven (and its password set again) through the enable path, with
      // the stored password, as the environment's own login.
      expect(state.enable).toEqual([
        { ownLogin: NEW, password: engine === "postgres" ? null : RO_PW },
      ]);
      for (const call of state.calls) {
        expect(call.command).not.toContain(ADMIN_PW);
      }
    });

    it(`is idempotent (${engine})`, async () => {
      setup(engine);
      for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
      expect(await step.plan(ctx())).toEqual([]);
    });
  }

  it("finishes a rename an earlier run did not record", async () => {
    setup("mssql");
    state.logins = new Set([NEW]);
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await step.apply(ctx(), item);
    expect(tables.environment_services?.[0]?.assistantDbLogin).toBe(NEW);
  });

  it("stores a password the enable path had to generate", async () => {
    setup("postgres", { serviceType: "systemd" });
    state.enableReturns = "NewGeneratedPw0123456789abcdefAB";
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await step.apply(ctx(), item);
    expect(tables.environment_services?.[0]?.assistantDbPassword).toBe(
      "enc:NewGeneratedPw0123456789abcdefAB"
    );
  });

  it("renames a login whose access is off without enabling it", async () => {
    setup("mysql", { assistantDbEnabled: false });
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await step.apply(ctx(), item);
    expect([...state.logins]).toEqual([NEW]);
    expect(state.enable).toEqual([]);
    expect(tables.environment_services?.[0]?.assistantDbLogin).toBe(NEW);
  });

  it("records the new name but fails when the login cannot log in", async () => {
    setup("mysql");
    state.enableFails = true;
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await expect(step.apply(ctx(), item)).rejects.toThrow(
      "turn the Assistant's database access off and on for kestrel-qa to reset the login"
    );
    expect(tables.environment_services?.[0]?.assistantDbLogin).toBe(NEW);
  });

  for (const engine of ["postgres", "mysql", "mssql"] as const) {
    it(`treats a gone login whose access is off as done (${engine})`, async () => {
      // A disable that dropped the login but could not forget it.
      setup(engine, { assistantDbEnabled: false });
      state.logins = new Set();
      const [item] = await step.plan(ctx());
      if (!item) throw new Error("no item");
      await step.apply(ctx(), item);
      expect(tables.environment_services?.[0]?.assistantDbLogin).toBe(NEW);
      expect(await step.plan(ctx())).toEqual([]);
    });
  }

  it("still fails a gone login whose access is on", async () => {
    setup("postgres");
    state.logins = new Set();
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await expect(step.apply(ctx(), item)).rejects.toThrow(/not found/);
    expect(tables.environment_services?.[0]?.assistantDbLogin).toBe(OLD);
  });

  it("renames a Postgres role only when it carries the environment's marker", () => {
    const sql = pgRenameAssistantDbSql({
      from: OLD,
      to: NEW,
      environmentId: ENV,
    });
    expect(sql).toContain(
      `format(''ALTER ROLE %I RENAME TO %I'', ''${OLD}'', ''${NEW}'')`
    );
    expect(sql).toContain(`''oldtool:${ENV}''`);
  });

  it("renames the SQL Server login and its database user", () => {
    const sql = mssqlRenameAssistantDbSql({
      database: "kestrel_qa",
      from: OLD,
      to: NEW,
    });
    expect(sql).toContain(
      "N'ALTER LOGIN ' + QUOTENAME(@old) + N' WITH NAME = ' + QUOTENAME(@new)"
    );
    expect(sql).toContain("ALTER USER");
  });
});
