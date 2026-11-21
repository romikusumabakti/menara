import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, type Row } from "./support/remark-db";

// The targets step against deploy dirs in a scratch directory: the remote
// commands it sends run in a real `sh` here, as they would over SSH, so the
// renames, the locks and the line rewrites are the real ones.

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const state = vi.hoisted(() => ({
  commands: [] as { server: string; command: string; readOnly: boolean }[],
  down: new Set<string>(),
}));

vi.mock("@/lib/ssh", () => ({
  executeRemoteCommand: async (
    target: { serverId: string },
    command: string,
    opts: { readOnly?: boolean } = {}
  ) => {
    state.commands.push({
      server: target.serverId,
      command,
      readOnly: opts.readOnly === true,
    });
    if (state.down.has(target.serverId)) {
      throw new Error("connect ECONNREFUSED");
    }
    const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    if (run.status !== 0) {
      throw new Error(`SSH Command Failed (exit ${run.status}): ${run.stdout}`);
    }
    return run.stdout;
  },
}));

const step = await import("@/lib/remark/targets");

const SRV = "0197f3a0-1b2c-7def-8000-0000000000a1";
const SRV2 = "0197f3a0-1b2c-7def-8000-0000000000a2";
const T_COMPOSE = "0197f3a0-1b2c-7def-8000-00000000d001";
const T_JAR = "0197f3a0-1b2c-7def-8000-00000000d002";
const T_STATIC = "0197f3a0-1b2c-7def-8000-00000000d003";
const T_DOWN = "0197f3a0-1b2c-7def-8000-00000000d004";

const LEGACY: Legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};

const OLD_ENV_HEADER =
  "# Managed by OldTool — edit variables in OldTool; local edits are overwritten on the next deploy.";
const NEW_ENV_HEADER =
  "# Managed by Menara — edit variables in Menara; local edits are overwritten on the next deploy.";
const OLD_OVERLAY_HEADER =
  "# Written by OldTool; do not edit. Joins the services to the shared database network.";
const NEW_OVERLAY_HEADER =
  "# Written by Menara; do not edit. Joins the services to the shared database network.";

let root: string;
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

const composeDir = () => join(root, "kestrel");
const jarDir = () => join(root, "osprey");
const webRoot = () => join(root, "www", "heron");

function write(path: string, content: string, mode = 0o600) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode });
}

const read = (path: string) => readFileSync(path, "utf8");

/** A compose dir, a jar dir and a web root an install on the old name left. */
function seedLegacy() {
  const d = composeDir();
  write(
    join(d, ".env"),
    `${OLD_ENV_HEADER}\nCOMPOSE_FILE=compose.yaml:compose.oldtool.yaml\nDB_PASSWORD='s3cret'\n`
  );
  write(join(d, ".env.oldtool-prev"), `${OLD_ENV_HEADER}\nA='1'\n`);
  write(join(d, ".env.oldtool-unmanaged"), "HAND=written\n");
  write(
    join(d, "compose.oldtool.yaml"),
    `${OLD_OVERLAY_HEADER}\nservices: {}\n`
  );
  write(join(d, "compose.yaml"), "services: {}\n", 0o644);
  mkdirSync(join(jarDir(), ".oldtool-prev"), { recursive: true });
  writeFileSync(join(jarDir(), ".oldtool-prev", "app.jar"), "jar");
  mkdirSync(`${webRoot()}.oldtool-prev`, { recursive: true });
  mkdirSync(webRoot(), { recursive: true });
}

/** The same dirs as a Menara install leaves them. */
function seedMenara() {
  const d = composeDir();
  write(
    join(d, ".env"),
    `${NEW_ENV_HEADER}\nCOMPOSE_FILE=compose.yaml:compose.menara.yaml\n`
  );
  write(join(d, "compose.menara.yaml"), `${NEW_OVERLAY_HEADER}\n`);
  // Hand-written text that only mentions the old name is not ours, in a
  // header file's first line neither.
  write(join(d, "notes.txt"), "moved from oldtool\n");
  write(
    join(d, "compose.menara.yaml.menara-prev"),
    "# notes from the oldtool days\n"
  );
  mkdirSync(join(jarDir(), ".menara-prev"), { recursive: true });
  mkdirSync(webRoot(), { recursive: true });
}

function target(id: string, kind: string, deployDir: string, serverId = SRV) {
  return {
    id,
    environmentId: "0197f3a0-1b2c-7def-8000-0000000e0001",
    componentKey: `c-${id.slice(-1)}`,
    serverId,
    kind,
    deployDir,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remark-targets-"));
  state.commands = [];
  state.down = new Set();
  errors = [];
  tables = {
    servers: [
      {
        id: SRV,
        name: "kestrel-app",
        host: "10.0.0.11",
        username: "deploy",
        password: null,
        auth: "key",
      },
      {
        id: SRV2,
        name: "osprey-app",
        host: "10.0.0.12",
        username: "deploy",
        password: null,
        auth: "key",
      },
    ],
    deploy_targets: [
      target(T_COMPOSE, "compose", composeDir()),
      target(T_JAR, "jar", jarDir()),
      target(T_STATIC, "static", webRoot()),
    ],
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("remark targets", () => {
  it("plans nothing without legacy data", async () => {
    seedMenara();
    expect(await step.plan(ctx())).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    seedLegacy();
    const d = composeDir();
    const items = await step.plan(ctx());
    expect(items).toEqual([
      {
        step: "targets",
        target: `deploy-targets/${T_COMPOSE}`,
        from: join(d, ".env.oldtool-unmanaged"),
        to: join(d, ".env.menara-unmanaged"),
      },
      {
        step: "targets",
        target: `deploy-targets/${T_COMPOSE}`,
        from: join(d, ".env.oldtool-prev"),
        to: join(d, ".env.menara-prev"),
      },
      {
        step: "targets",
        target: `deploy-targets/${T_COMPOSE}`,
        from: join(d, "compose.oldtool.yaml"),
        to: join(d, "compose.menara.yaml"),
      },
      {
        step: "targets",
        target: `deploy-targets/${T_COMPOSE}/.env`,
        from: OLD_ENV_HEADER,
        to: NEW_ENV_HEADER,
      },
      {
        step: "targets",
        target: `deploy-targets/${T_COMPOSE}/.env`,
        from: "COMPOSE_FILE=compose.yaml:compose.oldtool.yaml",
        to: "COMPOSE_FILE=compose.yaml:compose.menara.yaml",
      },
      {
        step: "targets",
        target: `deploy-targets/${T_COMPOSE}/.env.menara-prev`,
        from: OLD_ENV_HEADER,
        to: NEW_ENV_HEADER,
      },
      {
        step: "targets",
        target: `deploy-targets/${T_COMPOSE}/compose.menara.yaml`,
        from: OLD_OVERLAY_HEADER,
        to: NEW_OVERLAY_HEADER,
      },
      {
        step: "targets",
        target: `deploy-targets/${T_JAR}`,
        from: join(jarDir(), ".oldtool-prev"),
        to: join(jarDir(), ".menara-prev"),
      },
      {
        step: "targets",
        target: `deploy-targets/${T_STATIC}`,
        from: `${webRoot()}.oldtool-prev`,
        to: `${webRoot()}.menara-prev`,
      },
    ]);
    // No value of .env leaves the server in a plan, and nothing is written.
    expect(JSON.stringify(items)).not.toContain("s3cret");
    expect(state.commands.every((c) => c.readOnly)).toBe(true);
    expect(existsSync(join(d, "compose.oldtool.yaml"))).toBe(true);
    expect(existsSync(join(d, ".menara-deploy.lock"))).toBe(false);
  });

  it("apply converts it", async () => {
    seedLegacy();
    const d = composeDir();
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(read(join(d, ".env"))).toBe(
      `${NEW_ENV_HEADER}\nCOMPOSE_FILE=compose.yaml:compose.menara.yaml\nDB_PASSWORD='s3cret'\n`
    );
    expect(statSync(join(d, ".env")).mode & 0o777).toBe(0o600);
    expect(read(join(d, ".env.menara-prev"))).toBe(
      `${NEW_ENV_HEADER}\nA='1'\n`
    );
    expect(read(join(d, ".env.menara-unmanaged"))).toBe("HAND=written\n");
    expect(read(join(d, "compose.menara.yaml"))).toBe(
      `${NEW_OVERLAY_HEADER}\nservices: {}\n`
    );
    expect(existsSync(join(d, "compose.oldtool.yaml"))).toBe(false);
    expect(existsSync(join(jarDir(), ".menara-prev", "app.jar"))).toBe(true);
    expect(existsSync(`${webRoot()}.menara-prev`)).toBe(true);
    expect(existsSync(`${webRoot()}.oldtool-prev`)).toBe(false);
    // Applied under the target's deploy lock; no new legacy lock is created.
    expect(existsSync(join(d, ".menara-deploy.lock"))).toBe(true);
    expect(existsSync(join(d, ".oldtool-deploy.lock"))).toBe(false);
  });

  it("never overwrites a file already under the Menara name", async () => {
    seedLegacy();
    const d = composeDir();
    write(join(d, ".env.menara-prev"), "NEWER=1\n");
    const item = (await step.plan(ctx())).find(
      (i) => i.from === join(d, ".env.oldtool-prev")
    );
    if (!item) throw new Error("no item");
    await expect(step.apply(ctx(), item)).rejects.toThrow(/not overwriting/);
    expect(read(join(d, ".env.menara-prev"))).toBe("NEWER=1\n");
    expect(existsSync(join(d, ".env.oldtool-prev"))).toBe(true);
  });

  it("leaves COMPOSE_FILE alone while the overlay still has its old name", async () => {
    seedLegacy();
    const d = composeDir();
    const item = (await step.plan(ctx())).find((i) =>
      i.from.startsWith("COMPOSE_FILE=")
    );
    if (!item) throw new Error("no item");
    await expect(step.apply(ctx(), item)).rejects.toThrow(/overlay/);
    expect(read(join(d, ".env"))).toContain("compose.oldtool.yaml");
  });

  it("reports a server it cannot reach and plans the others", async () => {
    seedLegacy();
    tables.deploy_targets?.push(target(T_DOWN, "compose", "/srv/x", SRV2));
    state.down.add(SRV2);
    const items = await step.plan(ctx());
    expect(items).toHaveLength(9);
    expect(errors).toEqual([
      { target: `deploy-targets/${T_DOWN}`, message: "connect ECONNREFUSED" },
    ]);
  });

  it("is idempotent", async () => {
    seedLegacy();
    const items = await step.plan(ctx());
    for (const item of items) await step.apply(ctx(), item);
    // The same items again are already done.
    for (const item of items) await step.apply(ctx(), item);
    expect(await step.plan(ctx())).toEqual([]);
  });
});
