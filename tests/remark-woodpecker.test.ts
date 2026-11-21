import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Legacy } from "@/lib/legacy";
import type { RemarkContext } from "@/lib/remark/types";
import { fakeDb, fakeDrizzleOperators, type Row } from "./support/remark-db";

// The woodpecker step and `remark --finish` against a fake Woodpecker (repo
// secrets by repo id) and a fake Bitbucket (branches and their files). The
// notify secrets are "encrypted" with an `enc:` prefix the fake decrypt drops.

vi.mock("drizzle-orm", (orig) => fakeDrizzleOperators(orig));

const state = vi.hoisted(() => ({
  secrets: new Map<string, Map<string, string>>(),
  ops: [] as string[],
  failUpsert: false,
  failBranches: false,
  branches: new Map<string, Record<string, Record<string, string>>>(),
  forge: "bitbucket" as string,
  /** Woodpecker's per-repo pipeline path (`config_file`); "" is the default. */
  configFile: new Map<string, string>(),
  failConfig: false,
}));

vi.mock("@/lib/secrets", async (orig) => ({
  ...(await orig<typeof import("@/lib/secrets")>()),
  decryptSecret: (stored: string) => stored.replace(/^enc:/, ""),
}));

vi.mock("@/server/services/ci-connections", () => ({
  getProviderForConnection: async () => ({
    async upsertRepoSecret(repo: string, name: string, value: string) {
      state.ops.push(`upsert ${repo} ${name}`);
      if (state.failUpsert) {
        const { CiProviderError } = await import("@/lib/ci/types");
        throw new CiProviderError(`echo of ${value}`, 500);
      }
      const secrets = state.secrets.get(repo) ?? new Map();
      secrets.set(name, value);
      state.secrets.set(repo, secrets);
    },
    async listRepoSecrets(repo: string) {
      return [...(state.secrets.get(repo)?.keys() ?? [])];
    },
    async deleteRepoSecret(repo: string, name: string) {
      state.ops.push(`delete ${repo} ${name}`);
      state.secrets.get(repo)?.delete(name);
    },
    async getRepoConfigFile(repo: string) {
      if (state.failConfig) {
        const { CiProviderError } = await import("@/lib/ci/types");
        throw new CiProviderError("Woodpecker GET /api/repos/7 failed", 503);
      }
      return state.configFile.get(repo) ?? "";
    },
  }),
  getForgeCredentials: async () => ({
    forge: state.forge,
    auth: { username: "menara-bot", token: "fictional-forge-token" },
  }),
}));

vi.mock("@/lib/ci/forges/bitbucket", async (orig) => {
  const { FILE_TOO_LARGE } =
    await orig<typeof import("@/lib/ci/forges/bitbucket")>();
  const files = (repo: string, branch: string) =>
    state.branches.get(repo)?.[branch] ?? {};
  return {
    FILE_TOO_LARGE,
    listBranches: async (_auth: unknown, repo: string) => {
      if (state.failBranches) {
        const { CiProviderError } = await import("@/lib/ci/types");
        throw new CiProviderError("the branch list is incomplete", 0);
      }
      return Object.keys(state.branches.get(repo) ?? {});
    },
    listRepoDir: async (
      _auth: unknown,
      repo: string,
      branch: string,
      dir: string
    ) =>
      Object.keys(files(repo, branch))
        .filter((p) => p.startsWith(`${dir}/`))
        .map((path) => ({ path, type: "file" as const })),
    readRepoFileOrLarge: async (
      _auth: unknown,
      repo: string,
      branch: string,
      path: string
    ) => {
      const content = files(repo, branch)[path];
      if (content === "<too large>") return FILE_TOO_LARGE;
      return content ?? null;
    },
  };
});

const step = await import("@/lib/remark/woodpecker");

const LEGACY: Legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};
const CONN = "0197f3a0-1b2c-7def-8000-0000000c1001";
const SECRET_1 = "fictional-notify-value-1";
const SECRET_2 = "fictional-notify-value-2";
const SECRET_3 = "fictional-notify-value-3";

let tables: Record<string, Row[]>;

function ctx(): RemarkContext {
  return {
    legacy: LEGACY,
    db: fakeDb(tables),
    log: { info: () => {}, error: () => {} },
  };
}

const component = (
  componentKey: string,
  repo: string,
  ciRepoId: string | null,
  notifySecretName: string,
  secret: string
): Row => ({
  componentKey,
  ciConnectionId: CONN,
  repoFullName: repo,
  ciRepoId,
  notifySecretName,
  notifySecret: `enc:${secret}`,
});

function seedLegacy() {
  tables.app_components = [
    component("kestrel-api", "acme/kestrel", "7", "oldtool_notify", SECRET_1),
    component(
      "kestrel-web",
      "acme/kestrel",
      "7",
      "oldtool_notify_kestrel_web",
      SECRET_2
    ),
    // Two components sharing one secret (registered before per-component names).
    component("osprey-a", "acme/osprey", "9", "oldtool_notify", SECRET_3),
    component("osprey-b", "acme/osprey", "9", "oldtool_notify", SECRET_3),
    // Not activated in Woodpecker yet: no repo secret to write.
    component("heron-new", "acme/heron", null, "oldtool_notify", SECRET_1),
    ...seedOthersRows(),
  ];
  state.secrets.set(
    "7",
    new Map([
      ["oldtool_notify", SECRET_1],
      ["oldtool_notify_kestrel_web", SECRET_2],
      ["build_token", "fictional-build"],
    ])
  );
  state.secrets.set("9", new Map([["oldtool_notify", SECRET_3]]));
}

const seedOthersRows = (): Row[] => [
  component("heron-api", "acme/heron-api", "11", "menara_notify", SECRET_2),
];

beforeEach(() => {
  state.secrets = new Map();
  state.ops = [];
  state.failUpsert = false;
  state.failBranches = false;
  state.branches = new Map();
  state.forge = "bitbucket";
  state.configFile = new Map();
  state.failConfig = false;
  tables = { app_components: seedOthersRows() };
});

const names = () => tables.app_components?.map((r) => r.notifySecretName);

describe("remark woodpecker", () => {
  it("plans nothing without legacy data", async () => {
    expect(await step.plan(ctx())).toEqual([]);
  });

  it("plans one item per legacy trace", async () => {
    seedLegacy();
    const items = await step.plan(ctx());
    expect(items).toEqual([
      {
        step: "woodpecker",
        target: `ci/${CONN}/repos/7`,
        from: "oldtool_notify",
        to: "menara_notify",
      },
      {
        step: "woodpecker",
        target: `ci/${CONN}/repos/7`,
        from: "oldtool_notify_kestrel_web",
        to: "menara_notify_kestrel_web",
      },
      {
        step: "woodpecker",
        target: `ci/${CONN}/repos/9`,
        from: "oldtool_notify",
        to: "menara_notify",
      },
      {
        step: "woodpecker",
        target: "app_components/heron-new",
        from: "oldtool_notify",
        to: "menara_notify",
      },
    ]);
    // A dry run writes nothing, and no item carries a secret value.
    expect(state.ops).toEqual([]);
    expect(JSON.stringify(items)).not.toMatch(/fictional-notify/);
  });

  it("apply converts it", async () => {
    seedLegacy();
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    // The same values under the Menara names; the legacy ones stay for --finish.
    expect(Object.fromEntries(state.secrets.get("7") ?? [])).toEqual({
      oldtool_notify: SECRET_1,
      oldtool_notify_kestrel_web: SECRET_2,
      build_token: "fictional-build",
      menara_notify: SECRET_1,
      menara_notify_kestrel_web: SECRET_2,
    });
    expect(state.secrets.get("9")?.get("menara_notify")).toBe(SECRET_3);
    expect(state.ops).toEqual([
      "upsert 7 menara_notify",
      "upsert 7 menara_notify_kestrel_web",
      "upsert 9 menara_notify",
    ]);
    expect(names()).toEqual([
      "menara_notify",
      "menara_notify_kestrel_web",
      "menara_notify",
      "menara_notify",
      "menara_notify",
      "menara_notify",
    ]);
  });

  it("is idempotent", async () => {
    seedLegacy();
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    expect(await step.plan(ctx())).toEqual([]);
  });

  it("refuses components sharing a secret with different values", async () => {
    seedLegacy();
    const osprey = tables.app_components?.find(
      (r) => r.componentKey === "osprey-b"
    );
    if (osprey) osprey.notifySecret = "enc:fictional-other";
    const item = (await step.plan(ctx()))[2];
    if (!item) throw new Error("no item");
    await expect(step.apply(ctx(), item)).rejects.toThrow(
      /osprey-a, osprey-b share menara_notify but hold different notify secrets/
    );
    expect(state.ops).toEqual([]);
    expect(names()?.slice(2, 4)).toEqual(["oldtool_notify", "oldtool_notify"]);
  });

  it("keeps the row on the legacy name when Woodpecker refuses, without the value", async () => {
    seedLegacy();
    state.failUpsert = true;
    const [item] = await step.plan(ctx());
    if (!item) throw new Error("no item");
    const error = await step.apply(ctx(), item).catch((e: Error) => e);
    expect(String(error)).toContain(
      "storing the Woodpecker secret menara_notify failed (HTTP 500)"
    );
    expect(String(error)).not.toContain("fictional-notify");
    expect(names()?.[0]).toBe("oldtool_notify");
  });
});

describe("remark --finish", () => {
  async function converted() {
    seedLegacy();
    for (const item of await step.plan(ctx())) await step.apply(ctx(), item);
    state.ops = [];
  }

  it("keeps a secret a branch still references", async () => {
    await converted();
    state.branches.set("acme/kestrel", {
      main: { ".woodpecker.yaml": "from_secret: menara_notify_kestrel_web" },
      "release/2026-11": {
        ".woodpecker.yaml": "from_secret: oldtool_notify_kestrel_web",
      },
    });
    state.branches.set("acme/osprey", {
      main: { ".woodpecker/build.yaml": "from_secret: oldtool_notify" },
    });
    const report = await step.finish(ctx(), { apply: true });
    expect(
      report.entries.map((e) => [e.repo, e.secret, e.status, e.branches])
    ).toEqual([
      // `oldtool_notify` is not read by a branch naming `…_kestrel_web`.
      ["acme/kestrel", "oldtool_notify", "deleted", []],
      [
        "acme/kestrel",
        "oldtool_notify_kestrel_web",
        "kept",
        ["release/2026-11"],
      ],
      ["acme/osprey", "oldtool_notify", "kept", ["main"]],
    ]);
    expect(state.ops).toEqual(["delete 7 oldtool_notify"]);
    expect(step.formatFinishReport(report)).toContain(
      `ci/${CONN}/repos/7 (acme/kestrel): oldtool_notify_kestrel_web: kept, branches still reference it; update their pipeline files: release/2026-11`
    );
  });

  it("deletes a secret nothing references", async () => {
    await converted();
    state.branches.set("acme/kestrel", {
      main: { ".woodpecker.yaml": "from_secret: menara_notify" },
    });
    state.branches.set("acme/osprey", { main: {} });
    const report = await step.finish(ctx(), { apply: true });
    expect(report.failed).toBe(false);
    expect(state.ops.sort()).toEqual([
      "delete 7 oldtool_notify",
      "delete 7 oldtool_notify_kestrel_web",
      "delete 9 oldtool_notify",
    ]);
    expect([...(state.secrets.get("7")?.keys() ?? [])].sort()).toEqual([
      "build_token",
      "menara_notify",
      "menara_notify_kestrel_web",
    ]);
    // Nothing left: a rerun lists nothing.
    expect((await step.finish(ctx(), { apply: true })).entries).toEqual([]);
  });

  it("is a dry run without --apply", async () => {
    await converted();
    state.branches.set("acme/kestrel", { main: {} });
    state.branches.set("acme/osprey", { main: {} });
    const report = await step.finish(ctx(), { apply: false });
    expect(report.entries.map((e) => e.status)).toEqual([
      "unused",
      "unused",
      "unused",
    ]);
    expect(state.ops).toEqual([]);
    expect(step.formatFinishReport(report)[0]).toContain("dry run");
  });

  it("keeps a secret a component still uses, or that cannot be checked", async () => {
    seedLegacy();
    state.branches.set("acme/kestrel", {
      main: { ".woodpecker.yaml": "<too large>" },
    });
    const report = await step.finish(ctx(), { apply: true });
    expect(report.entries.map((e) => [e.secret, e.status, e.reason])).toEqual([
      [
        "oldtool_notify",
        "kept",
        "components kestrel-api still use it; run remark --step woodpecker --apply first",
      ],
      [
        "oldtool_notify_kestrel_web",
        "kept",
        "components kestrel-web still use it; run remark --step woodpecker --apply first",
      ],
      [
        "oldtool_notify",
        "kept",
        "components osprey-a, osprey-b still use it; run remark --step woodpecker --apply first",
      ],
    ]);
    await converted();
    state.branches.set("acme/kestrel", {
      main: { ".woodpecker.yaml": "<too large>" },
    });
    state.forge = "github";
    const unread = await step.finish(ctx(), { apply: true });
    expect(unread.entries.every((e) => e.status === "kept")).toBe(true);
    expect(unread.entries[0]?.reason).toBe(
      "reading github branches is not supported"
    );
    expect(state.ops).toEqual([]);
  });

  it("keeps every secret when the branch list is incomplete", async () => {
    await converted();
    state.failBranches = true;
    const report = await step.finish(ctx(), { apply: true });
    expect(report.entries.map((e) => [e.secret, e.status, e.reason])).toEqual([
      [
        "oldtool_notify",
        "kept",
        "the branches could not be read (the branch list is incomplete)",
      ],
      [
        "oldtool_notify_kestrel_web",
        "kept",
        "the branches could not be read (the branch list is incomplete)",
      ],
      [
        "oldtool_notify",
        "kept",
        "the branches could not be read (the branch list is incomplete)",
      ],
    ]);
    expect(state.ops).toEqual([]);
  });

  it("reads a custom pipeline path on every branch", async () => {
    await converted();
    state.configFile.set("7", ".ci/build.yaml");
    state.configFile.set("9", "pipelines/");
    state.branches.set("acme/kestrel", {
      main: { ".ci/build.yaml": "from_secret: oldtool_notify" },
      dev: { ".ci/build.yaml": "from_secret: menara_notify" },
    });
    state.branches.set("acme/osprey", {
      main: { "pipelines/deploy.yml": "from_secret: oldtool_notify" },
    });
    const report = await step.finish(ctx(), { apply: true });
    expect(
      report.entries.map((e) => [e.repo, e.secret, e.status, e.branches])
    ).toEqual([
      ["acme/kestrel", "oldtool_notify", "kept", ["main"]],
      ["acme/kestrel", "oldtool_notify_kestrel_web", "deleted", []],
      ["acme/osprey", "oldtool_notify", "kept", ["main"]],
    ]);
    expect(state.ops).toEqual(["delete 7 oldtool_notify_kestrel_web"]);
  });

  it("keeps every secret when the custom pipeline path cannot be read", async () => {
    await converted();
    state.configFile.set("7", ".ci/build.yaml");
    state.branches.set("acme/kestrel", {
      main: { ".ci/build.yaml": "from_secret: menara_notify" },
      "release/2026-11": { ".woodpecker.yaml": "steps: {}" },
    });
    state.branches.set("acme/osprey", { main: {} });
    const report = await step.finish(ctx(), { apply: true });
    const kestrel = report.entries.filter((e) => e.repo === "acme/kestrel");
    expect(kestrel.map((e) => [e.status, e.reason, e.branches])).toEqual([
      [
        "kept",
        "custom pipeline path .ci/build.yaml could not be read",
        ["release/2026-11"],
      ],
      [
        "kept",
        "custom pipeline path .ci/build.yaml could not be read",
        ["release/2026-11"],
      ],
    ]);
    // The default-path repo is unaffected.
    expect(state.ops).toEqual(["delete 9 oldtool_notify"]);
  });

  it("keeps every secret when the pipeline path cannot be looked up", async () => {
    await converted();
    state.failConfig = true;
    state.branches.set("acme/kestrel", { main: {} });
    state.branches.set("acme/osprey", { main: {} });
    const report = await step.finish(ctx(), { apply: true });
    expect(report.entries.map((e) => [e.status, e.reason])).toEqual([
      [
        "kept",
        "custom pipeline path could not be checked (Woodpecker GET /api/repos/7 failed)",
      ],
      [
        "kept",
        "custom pipeline path could not be checked (Woodpecker GET /api/repos/7 failed)",
      ],
      [
        "kept",
        "custom pipeline path could not be checked (Woodpecker GET /api/repos/7 failed)",
      ],
    ]);
    expect(state.ops).toEqual([]);
  });
});
