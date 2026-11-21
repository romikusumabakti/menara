import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, type Row } from "./support/remark-db";

// The ssh step against fake authorized_keys files: one per server, read and
// written through the server-keys helpers (faked here), with a key login
// proof whose outcome each test decides.

const KEY = "0197f3a0-1b2c-7def-8000-00000000c0de";
const OTHER_KEY = "0197f3a0-1b2c-7def-8000-00000000beef";
const S1 = "0197f3a0-1b2c-7def-8000-0000000000a1";
const S2 = "0197f3a0-1b2c-7def-8000-0000000000a2";
const LEGACY_MARKER = `oldtool:oldtool-beta:${KEY}`;
const NEW_MARKER = `menara:beta:${KEY}`;
const BODY =
  'from="10.0.0.5",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK';
const FOREIGN = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF romi@laptop";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as { server: string; content: string }[],
  prove: (_server: string, _content: string): boolean => true,
  proofs: [] as { server: string; keyId: string; content: string }[],
  locks: new Set<string>(),
  unreachable: new Set<string>(),
}));

vi.mock("@/lib/ssh", () => ({
  openSsh: async (target: { serverId: string }) => {
    if (state.unreachable.has(target.serverId)) {
      throw new Error("connect ECONNREFUSED");
    }
    return { server: target.serverId, dispose: () => {} };
  },
}));

vi.mock("@/server/services/server-keys", () => ({
  SSH_TUNING: {},
  readAuthorizedKeys: async (ssh: { server: string }) =>
    state.files.get(ssh.server) ?? "",
  writeAuthorizedKeys: async (ssh: { server: string }, content: string) => {
    state.files.set(ssh.server, content);
    state.writes.push({ server: ssh.server, content });
  },
  proveKeyLogin: async (target: { serverId: string }, keyId: string) => {
    const content = state.files.get(target.serverId) ?? "";
    state.proofs.push({ server: target.serverId, keyId, content });
    return state.prove(target.serverId, content) ? null : "keyLoginFailed";
  },
}));

vi.mock("@/lib/ssh-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ssh-keys")>()),
  serverKeyLock: async (id: string) => {
    if (state.locks.has(id)) return null;
    state.locks.add(id);
    return async () => {
      state.locks.delete(id);
    };
  },
}));

const ssh = await import("@/lib/remark/ssh");

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

function server(id: string, keyId = KEY): Row {
  return {
    id,
    name: id === S1 ? "kestrel-app" : "osprey-db",
    host: id === S1 ? "10.0.0.11" : "10.0.0.12",
    username: "deploy",
    password: null,
    auth: "key",
    sshKeyId: keyId,
  };
}

beforeEach(() => {
  vi.stubEnv("COMPOSE_PROJECT_NAME", "beta");
  vi.stubEnv("MENARA_LEGACY_NAME", "oldtool");
  vi.stubEnv("MENARA_LEGACY_INSTANCE", "oldtool-beta");
  state.files = new Map();
  state.writes = [];
  state.proofs = [];
  state.prove = () => true;
  state.locks = new Set();
  state.unreachable = new Set();
  errors = [];
  tables = {
    ssh_keys: [
      { id: KEY, status: "current" },
      { id: OTHER_KEY, status: "retired" },
    ],
    servers: [server(S1), server(S2)],
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("remark ssh", () => {
  it("plans nothing without legacy data", async () => {
    state.files.set(S1, `${FOREIGN}\n${BODY} ${NEW_MARKER}\n`);
    state.files.set(S2, "");
    expect(await ssh.plan(ctx())).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    state.files.set(S1, `${FOREIGN}\n${BODY} ${LEGACY_MARKER}\n`);
    state.files.set(S2, `${BODY} ${NEW_MARKER}\n`);
    // A password server holds no line of ours and is not visited.
    tables.servers?.push({ ...server("x"), auth: "password", sshKeyId: null });
    state.unreachable.add("x");
    expect(await ssh.plan(ctx())).toEqual([
      {
        step: "ssh",
        target: `servers/${S1}`,
        from: LEGACY_MARKER,
        to: NEW_MARKER,
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("reports an unreachable server and plans the others", async () => {
    state.unreachable.add(S1);
    state.files.set(S2, `${BODY} ${LEGACY_MARKER}\n`);
    const items = await ssh.plan(ctx());
    expect(items.map((i) => i.target)).toEqual([`servers/${S2}`]);
    expect(errors).toEqual([
      { target: `servers/${S1}`, message: "connect ECONNREFUSED" },
    ]);
  });

  it("apply converts it", async () => {
    state.files.set(S1, `${FOREIGN}\n${BODY} ${LEGACY_MARKER}\n`);
    const [item] = await ssh.plan(ctx());
    if (!item) throw new Error("no item");
    await ssh.apply(ctx(), item);
    expect(state.files.get(S1)).toBe(`${FOREIGN}\n${BODY} ${NEW_MARKER}\n`);
    expect(state.locks.size).toBe(0);
  });

  it("rewrites the marker before removing the old line", async () => {
    state.files.set(S1, `${FOREIGN}\n${BODY} ${LEGACY_MARKER}\n`);
    const [item] = await ssh.plan(ctx());
    if (!item) throw new Error("no item");
    await ssh.apply(ctx(), item);
    expect(state.writes.map((w) => w.content)).toEqual([
      `${FOREIGN}\n${BODY} ${LEGACY_MARKER}\n${BODY} ${NEW_MARKER}\n`,
      `${FOREIGN}\n${BODY} ${NEW_MARKER}\n`,
    ]);
    // Proven with the instance key while both lines were there, then again
    // with the new line alone.
    expect(state.proofs).toEqual([
      { server: S1, keyId: KEY, content: state.writes[0]?.content },
      { server: S1, keyId: KEY, content: state.writes[1]?.content },
    ]);
  });

  it("keeps the legacy line when verification fails", async () => {
    const before = `${FOREIGN}\n${BODY} ${LEGACY_MARKER}\n`;
    state.files.set(S1, before);
    state.prove = () => false;
    const [item] = await ssh.plan(ctx());
    if (!item) throw new Error("no item");
    await expect(ssh.apply(ctx(), item)).rejects.toThrow(/legacy line is kept/);
    expect(state.files.get(S1)).toBe(before);
    expect(state.locks.size).toBe(0);
  });

  it("puts the legacy line back when the new line alone fails", async () => {
    state.files.set(S1, `${FOREIGN}\n${BODY} ${LEGACY_MARKER}\n`);
    state.prove = (_s, content) => content.includes(LEGACY_MARKER);
    const [item] = await ssh.plan(ctx());
    if (!item) throw new Error("no item");
    await expect(ssh.apply(ctx(), item)).rejects.toThrow(/put back/);
    expect(state.files.get(S1)).toContain(`${BODY} ${LEGACY_MARKER}`);
  });

  it("refuses while another key operation holds the server", async () => {
    state.files.set(S1, `${BODY} ${LEGACY_MARKER}\n`);
    const [item] = await ssh.plan(ctx());
    if (!item) throw new Error("no item");
    state.locks.add(S1);
    await expect(ssh.apply(ctx(), item)).rejects.toThrow(/key operation/);
    expect(state.writes).toEqual([]);
  });

  it("is idempotent", async () => {
    state.files.set(S1, `${BODY} ${LEGACY_MARKER}\n`);
    state.files.set(S2, `${BODY} ${LEGACY_MARKER}\n`);
    for (const item of await ssh.plan(ctx())) await ssh.apply(ctx(), item);
    expect(await ssh.plan(ctx())).toEqual([]);
  });
});
