import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { REMARK_STEPS } from "@/lib/remark/types";

const state = vi.hoisted(() => ({
  hits: {} as Record<string, { target: string; from: string }[]>,
  unreachable: {} as Record<string, string>,
  thrown: {} as Record<string, string>,
  finish: [] as { target: string; repo: string; secret: string }[],
  finishApply: [] as boolean[],
}));

for (const step of REMARK_STEPS) {
  vi.doMock(`@/lib/remark/${step}`, () => ({
    plan: async (ctx: RemarkContext): Promise<RemarkItem[]> => {
      if (state.thrown[step]) throw new Error(state.thrown[step]);
      if (state.unreachable[step]) {
        ctx.log.error(`${step}/x`, state.unreachable[step] as string);
      }
      return (state.hits[step] ?? []).map((h) => ({
        step,
        target: h.target,
        from: h.from,
        to: "menara",
      }));
    },
    apply: async () => {
      throw new Error("sweep must never apply");
    },
  }));
}
vi.doMock("@/lib/remark/woodpecker", async () => ({
  plan: async () => [],
  apply: async () => {
    throw new Error("sweep must never apply");
  },
  finish: async (_ctx: unknown, opts: { apply: boolean }) => {
    state.finishApply.push(opts.apply);
    return {
      apply: opts.apply,
      failed: false,
      errors: [],
      entries: state.finish.map((e) => ({
        ...e,
        status: "unused",
        branches: [],
      })),
    };
  },
}));

const { runSweep, formatSweepReport } = await import("@/lib/sweep/run");
const { HISTORICAL_TABLES, scanDatabase } = await import("@/lib/sweep/db-scan");

const legacy = {
  name: "oldtool",
  upper: "OLDTOOL",
  title: "Oldtool",
  instance: "oldtool-beta",
};
const noDb = async () => [];
const base = { legacy, db: {} as never };

beforeEach(() => {
  state.hits = {};
  state.unreachable = {};
  state.thrown = {};
  state.finish = [];
  state.finishApply = [];
});

describe("runSweep", () => {
  it("reports a hit per system", async () => {
    state.hits = {
      ssh: [{ target: "servers/s1", from: "oldtool:oldtool-beta:k1" }],
      cloudflare: [{ target: "zones/z1", from: "oldtool-beta tunnel" }],
      s3: [{ target: "s3/c1", from: "oldtool/backups/a.tar" }],
    };
    state.finish = [
      {
        target: "ci/c1/repos/7",
        repo: "acme/kestrel",
        secret: "oldtool_notify",
      },
    ];
    const report = await runSweep(base, {
      scanColumn: async (target) =>
        target.table === "issues" && target.column === "title"
          ? [{ id: "i1", value: "see the oldtool docs" }]
          : [],
    });
    expect(report.failed).toBe(true);
    expect(report.hits).toEqual(
      expect.arrayContaining([
        {
          system: "ssh",
          location: "servers/s1",
          excerpt: "oldtool:oldtool-beta:k1",
        },
        {
          system: "cloudflare",
          location: "zones/z1",
          excerpt: "oldtool-beta tunnel",
        },
        { system: "s3", location: "s3/c1", excerpt: "oldtool/backups/a.tar" },
        {
          system: "woodpecker-secrets",
          location: "ci/c1/repos/7",
          excerpt: "acme/kestrel: oldtool_notify",
        },
        expect.objectContaining({
          system: "database",
          location: "issues.title (i1)",
          excerpt: "see the oldtool docs",
        }),
      ])
    );
    expect(new Set(report.hits.map((h) => h.system))).toEqual(
      new Set(["ssh", "cloudflare", "s3", "woodpecker-secrets", "database"])
    );
    // Read-only: --finish runs as a dry run.
    expect(state.finishApply).toEqual([false]);
  });

  it("exits clean when nothing is left", async () => {
    const report = await runSweep(base, { scanColumn: noDb });
    expect(report.hits).toEqual([]);
    expect(report.failed).toBe(false);
    expect(formatSweepReport(report)).toEqual([
      "menara sweep: no trace of the previous name found.",
    ]);
  });

  it("reports an unreachable system and fails", async () => {
    state.unreachable = { ssh: "connection refused" };
    state.thrown = { jira: "no connection" };
    const report = await runSweep(base, { scanColumn: noDb });
    expect(report.failed).toBe(true);
    expect(report.hits).toEqual([
      {
        system: "ssh",
        location: "ssh/x",
        excerpt: "could not check: connection refused",
      },
      {
        system: "jira",
        location: "jira",
        excerpt: "could not check: no connection",
      },
    ]);
  });

  it("truncates a long excerpt", async () => {
    state.hits = {
      s3: [{ target: "s3/c1", from: `oldtool ${"x".repeat(500)}` }],
    };
    const report = await runSweep(base, { scanColumn: noDb });
    expect(report.hits[0]?.excerpt.length).toBeLessThanOrEqual(121);
  });
});

describe("scanDatabase", () => {
  it("excludes historical log tables and secret columns", async () => {
    const scanned: string[] = [];
    const columns: string[] = [];
    await scanDatabase(base.db, legacy, async (target) => {
      scanned.push(target.table);
      columns.push(`${target.table}.${target.column}`);
      return [];
    });
    expect(columns).not.toContain("ssh_keys.private_key");
    expect(columns).not.toContain("accounts.access_token");
    expect(columns).not.toContain("environment_variables.value");
    expect(scanned).not.toContain("verifications");
    for (const name of [
      "activity_log",
      "runs",
      "assistant_messages",
      "assistant_conversations",
      "notifications",
    ]) {
      expect(HISTORICAL_TABLES.has(name)).toBe(true);
      expect(scanned).not.toContain(name);
    }
    expect(scanned).toContain("issues");
    expect(scanned).toContain("instance_settings");
  });

  it("keeps only whole-word matches and skips ciphertext", async () => {
    const hits = await scanDatabase(base.db, legacy, async (target) =>
      target.table === "projects" && target.column === "name"
        ? [
            { id: "p1", value: "oldtoolkit" },
            { id: "p2", value: "enc:v1:oldtool" },
            { id: "p3", value: "Oldtool rocks" },
          ]
        : []
    );
    expect(hits.map((h) => h.location)).toEqual(["projects.name (p3)"]);
    expect(hits.some((h) => h.location.endsWith("(p1)"))).toBe(false);
    expect(hits.some((h) => h.location.endsWith("(p2)"))).toBe(false);
  });
});
