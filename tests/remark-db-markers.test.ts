import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, type Row } from "./support/remark-db";

// The db-markers step against fake Postgres clusters: each is a list of
// roles with their comments, reached by the container (or service) name in
// the command; the step's SQL arrives on stdin as it would over SSH.

const ENV1 = "0197f3a0-1b2c-7def-8000-0000000e0001";
const ENV2 = "0197f3a0-1b2c-7def-8000-0000000e0002";
const FOREIGN_ENV = "0197f3a0-1b2c-7def-8000-0000000e0999";
const HOST = "0197f3a0-1b2c-7def-8000-0000000d0001";
const SRV = "0197f3a0-1b2c-7def-8000-0000000000a1";
const SVC_SHARED = "0197f3a0-1b2c-7def-8000-0000000c0001";
const SVC_OWN = "0197f3a0-1b2c-7def-8000-0000000c0002";

type Role = { role: string; comment: string | null };

const state = vi.hoisted(() => ({
  clusters: new Map<string, { role: string; comment: string | null }[]>(),
  commands: [] as { command: string; stdin: string; readOnly?: boolean }[],
  down: new Set<string>(),
}));

function clusterOf(command: string): string {
  for (const name of state.clusters.keys()) {
    if (command.includes(`'${name}'`)) return name;
  }
  throw new Error(`no cluster in ${command}`);
}

vi.mock("@/lib/ssh", () => ({
  executeRemoteCommand: async (
    _target: unknown,
    command: string,
    opts: { stdin?: string; readOnly?: boolean }
  ) => {
    const stdin = opts.stdin ?? "";
    state.commands.push({ command, stdin, readOnly: opts.readOnly });
    const name = clusterOf(command);
    if (state.down.has(name)) throw new Error("connect ECONNREFUSED");
    const roles = state.clusters.get(name) ?? [];
    if (stdin.includes("json_agg")) {
      const like = /LIKE '([^']*)%'/.exec(stdin)?.[1] ?? "";
      return JSON.stringify(roles.filter((r) => r.comment?.startsWith(like)));
    }
    const set =
      /format\(''COMMENT ON ROLE %I IS %L'', ''((?:[^']|'''')*)'', ''([^']*)''\)/.exec(
        stdin
      );
    if (!set?.[1] || !set[2]) throw new Error("unexpected SQL");
    const role = roles.find((r) => r.role === set[1]?.replaceAll("''", "'"));
    if (!role) throw new Error("role not found");
    role.comment = set[2];
    return "";
  },
}));

const step = await import("@/lib/remark/db-markers");

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

function service(id: string, environmentId: string, extra: Row): Row {
  return {
    id,
    environmentId,
    role: "db",
    serverId: SRV,
    dbType: "postgres",
    dbName: "kestrel_qa",
    assistantDbLogin: null,
    databaseHostId: null,
    dbKind: "container",
    ...extra,
  };
}

function setClusters(shared: Role[], own: Role[]) {
  state.clusters.set("pg-shared", shared);
  state.clusters.set("osprey-db", own);
}

beforeEach(() => {
  state.clusters = new Map();
  state.commands = [];
  state.down = new Set();
  errors = [];
  tables = {
    environments: [{ id: ENV1 }, { id: ENV2 }],
    servers: [
      {
        id: SRV,
        name: "heron-db",
        host: "10.0.0.20",
        username: "root",
        password: null,
        auth: "key",
        sshKeyId: null,
      },
    ],
    database_hosts: [{ id: HOST, serverId: SRV, containerName: "pg-shared" }],
    environment_services: [
      // On the shared host: its roles are the host's, read once.
      service(SVC_SHARED, ENV1, {
        serviceType: "docker",
        serviceName: "pg-shared",
        dbKind: "shared",
        databaseHostId: HOST,
        assistantDbLogin: "menara_ro_kestrel_qa",
      }),
      service(SVC_OWN, ENV2, {
        serviceType: "docker",
        serviceName: "osprey-db",
        assistantDbLogin: "oldtool_ro_osprey",
      }),
      // No assistant login: Menara made no role there.
      service("0197f3a0-1b2c-7def-8000-0000000c0003", ENV2, {
        role: "db",
        serviceType: "docker",
        serviceName: "untouched-db",
      }),
    ],
  };
});

describe("remark db-markers", () => {
  it("plans nothing without legacy data", async () => {
    setClusters(
      [
        { role: "kestrel_app", comment: `menara:${ENV1}` },
        { role: "someone", comment: "made by hand" },
      ],
      [{ role: "menara_ro_osprey", comment: `menara:${ENV2}` }]
    );
    expect(await step.plan(ctx())).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    setClusters(
      [
        { role: "kestrel_app", comment: `oldtool:${ENV1}` },
        { role: "oldtool_ro_kestrel_qa", comment: `oldtool:${ENV1}` },
        // Another instance's environment: not ours to convert.
        { role: "foreign_app", comment: `oldtool:${FOREIGN_ENV}` },
        { role: "kestrel_new", comment: `menara:${ENV1}` },
      ],
      [{ role: "oldtool_ro_osprey", comment: `oldtool:${ENV2}` }]
    );
    expect(await step.plan(ctx())).toEqual([
      {
        step: "db-markers",
        target: `database-hosts/${HOST}/roles/kestrel_app`,
        from: `oldtool:${ENV1}`,
        to: `menara:${ENV1}`,
      },
      {
        step: "db-markers",
        target: `database-hosts/${HOST}/roles/oldtool_ro_kestrel_qa`,
        from: `oldtool:${ENV1}`,
        to: `menara:${ENV1}`,
      },
      {
        step: "db-markers",
        target: `services/${SVC_OWN}/roles/oldtool_ro_osprey`,
        from: `oldtool:${ENV2}`,
        to: `menara:${ENV2}`,
      },
    ]);
    // Two clusters read, once each: the shared service is the host's.
    expect(state.commands).toHaveLength(2);
  });

  it("reports a cluster it cannot reach and plans the others", async () => {
    setClusters(
      [],
      [{ role: "oldtool_ro_osprey", comment: `oldtool:${ENV2}` }]
    );
    state.down.add("pg-shared");
    const items = await step.plan(ctx());
    expect(items.map((i) => i.target)).toEqual([
      `services/${SVC_OWN}/roles/oldtool_ro_osprey`,
    ]);
    expect(errors).toEqual([
      { target: `database-hosts/${HOST}`, message: "connect ECONNREFUSED" },
    ]);
  });

  it("apply converts it", async () => {
    setClusters([{ role: "kestrel_app", comment: `oldtool:${ENV1}` }], []);
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    await step.apply(ctx(), item);
    expect(state.clusters.get("pg-shared")).toEqual([
      { role: "kestrel_app", comment: `menara:${ENV1}` },
    ]);
    // The comment is changed only while it still is the legacy marker.
    const sql = state.commands.at(-1)?.stdin ?? "";
    expect(sql).toContain(`IS DISTINCT FROM ''oldtool:${ENV1}''`);
  });

  it("refuses an item whose markers are not this environment's", async () => {
    setClusters([{ role: "kestrel_app", comment: `oldtool:${ENV1}` }], []);
    await expect(
      step.apply(ctx(), {
        step: "db-markers",
        target: `database-hosts/${HOST}/roles/kestrel_app`,
        from: `oldtool:${ENV1}`,
        to: `menara:${ENV2}`,
      })
    ).rejects.toThrow(/not this instance's/);
  });

  it("plans over connections that write nothing to Menara's database", async () => {
    setClusters([{ role: "kestrel_app", comment: `oldtool:${ENV1}` }], []);
    const [item] = await step.plan(ctx());
    expect(state.commands.map((c) => c.readOnly)).toEqual([true, true]);
    if (!item) throw new Error("no item");
    state.commands = [];
    await step.apply(ctx(), item);
    expect(state.commands.map((c) => c.readOnly)).toEqual([false]);
  });

  it("is idempotent", async () => {
    setClusters(
      [{ role: "kestrel_app", comment: `oldtool:${ENV1}` }],
      [{ role: "oldtool_ro_osprey", comment: `oldtool:${ENV2}` }]
    );
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(await step.plan(ctx())).toEqual([]);
  });
});
