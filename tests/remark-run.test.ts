import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";

const state = vi.hoisted(() => ({ applied: [] as string[] }));

const item = (target: string): RemarkItem => ({
  step: "ssh",
  target,
  from: "oldtool:oldtool-beta:k",
  to: "menara:beta:k",
});

vi.mock("@/lib/remark/ssh", () => ({
  plan: async () => [item("servers/a"), item("servers/b")],
  apply: async (_ctx: unknown, i: RemarkItem) => {
    if (i.target === "servers/a") throw new Error("key login failed");
    state.applied.push(i.target);
  },
}));
vi.mock("@/lib/remark/db-markers", () => ({
  plan: async () => {
    throw new Error("no database hosts table");
  },
  apply: async () => {},
}));
vi.mock("@/lib/remark/assistant-logins", () => ({
  plan: async (ctx: RemarkContext) => {
    ctx.log.error("services/x", "unreachable");
    return [];
  },
  apply: async () => {},
}));

// Built, with nothing to convert here.
for (const step of [
  "cloudflare",
  "targets",
  "s3",
  "woodpecker",
  "jira",
  "instance-db",
]) {
  vi.doMock(`@/lib/remark/${step}`, () => ({
    plan: async () => [],
    apply: async () => {},
  }));
}

const { runRemark, formatRemarkReport } = await import("@/lib/remark/run");

const base = {
  legacy: {
    name: "oldtool",
    upper: "OLDTOOL",
    title: "Oldtool",
    instance: null,
  },
  db: {} as never,
};

beforeEach(() => {
  state.applied = [];
});

describe("runRemark", () => {
  it("plans only on a dry run", async () => {
    const report = await runRemark(base, { apply: false, steps: ["ssh"] });
    expect(state.applied).toEqual([]);
    expect(report.steps.map((s) => s.step)).toEqual(["ssh"]);
    expect(report.steps[0]?.items.map((i) => i.status)).toEqual([
      "planned",
      "planned",
    ]);
    expect(report.failed).toBe(false);
  });

  it("goes on past a failing item, plan and target, and fails at the end", async () => {
    const report = await runRemark(base, { apply: true });
    expect(state.applied).toEqual(["servers/b"]);
    const [ssh, dbMarkers, logins, ...rest] = report.steps;
    expect(ssh?.items.map((i) => [i.target, i.status, i.error])).toEqual([
      ["servers/a", "failed", "key login failed"],
      ["servers/b", "converted", undefined],
    ]);
    expect(dbMarkers?.errors).toEqual([
      { target: "db-markers", message: "no database hosts table" },
    ]);
    expect(logins?.errors).toEqual([
      { target: "services/x", message: "unreachable" },
    ]);
    expect(rest.map((s) => [s.step, s.items, s.errors])).toEqual([
      ["cloudflare", [], []],
      ["targets", [], []],
      ["s3", [], []],
      ["woodpecker", [], []],
      ["jira", [], []],
      ["instance-db", [], []],
    ]);
    expect(report.failed).toBe(true);
    expect(formatRemarkReport(report)).toContain(
      "  servers/a: oldtool:oldtool-beta:k -> menara:beta:k [failed]: key login failed"
    );
  });
});
