import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as { apply: boolean; steps?: readonly string[] }[],
  finish: [] as { apply: boolean }[],
  failed: false,
}));

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/remark/woodpecker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/remark/woodpecker")>();
  return {
    ...actual,
    finish: vi.fn(async (_ctx: unknown, opts: { apply: boolean }) => {
      state.finish.push(opts);
      return {
        apply: opts.apply,
        failed: state.failed,
        errors: [],
        entries: [
          {
            target: "ci/c1/repos/7",
            repo: "acme/kestrel",
            secret: "oldtool_notify",
            status: opts.apply
              ? state.failed
                ? "failed"
                : "deleted"
              : "unused",
            branches: [],
          },
        ],
      };
    }),
  };
});

vi.mock("@/lib/remark/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/remark/run")>();
  return {
    ...actual,
    runRemark: vi.fn(
      async (_ctx: unknown, opts: { apply: boolean; steps?: string[] }) => {
        state.calls.push(opts);
        return {
          apply: opts.apply,
          failed: state.failed,
          steps: [
            {
              step: "ssh",
              errors: [],
              items: [
                {
                  step: "ssh",
                  target: "servers/s1",
                  from: "oldtool:oldtool-beta:k1",
                  to: "menara:beta:k1",
                  status: opts.apply ? "converted" : "planned",
                },
              ],
            },
          ],
        };
      }
    ),
  };
});

const { parseRemarkArgs, runRemarkCommand } = await import(
  "@/scripts/cli/remark"
);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

beforeEach(() => {
  state.calls = [];
  state.finish = [];
  state.failed = false;
  vi.stubEnv("MENARA_LEGACY_NAME", "oldtool");
  vi.stubEnv("MENARA_LEGACY_INSTANCE", "oldtool-beta");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("menara remark", () => {
  it("is a dry run by default", async () => {
    const { out, io } = capture();
    expect(await runRemarkCommand([], io)).toBe(0);
    expect(state.calls).toEqual([{ apply: false, steps: [] }]);
    expect(out.join("\n")).toContain("dry run");
    expect(out.join("\n")).toContain(
      "servers/s1: oldtool:oldtool-beta:k1 -> menara:beta:k1"
    );
  });

  it("converts with --apply and exits 1 when an item failed", async () => {
    state.failed = true;
    const { io } = capture();
    expect(await runRemarkCommand(["--apply"], io)).toBe(1);
    expect(state.calls).toEqual([{ apply: true, steps: [] }]);
  });

  it("exits 2 without legacy config", async () => {
    vi.stubEnv("MENARA_LEGACY_NAME", "");
    const { err, io } = capture();
    expect(await runRemarkCommand([], io)).toBe(2);
    expect(state.calls).toEqual([]);
    expect(err.join("\n")).toContain("MENARA_LEGACY_NAME");
  });

  it("passes the chosen steps", async () => {
    const { io } = capture();
    expect(
      await runRemarkCommand(["--step", "ssh", "--step", "db-markers"], io)
    ).toBe(0);
    expect(state.calls).toEqual([
      { apply: false, steps: ["ssh", "db-markers"] },
    ]);
  });

  it("refuses an unknown step", async () => {
    const { err, io } = capture();
    expect(await runRemarkCommand(["--step", "nope"], io)).toBe(1);
    expect(state.calls).toEqual([]);
    expect(err.join("\n")).toContain("Unknown step: nope");
  });

  it("--finish is a dry run without --apply", async () => {
    const { out, io } = capture();
    expect(await runRemarkCommand(["--finish"], io)).toBe(0);
    expect(state.finish).toEqual([{ apply: false }]);
    expect(state.calls).toEqual([]);
    expect(out.join("\n")).toContain("dry run");
    expect(out.join("\n")).toContain(
      "oldtool_notify: unused, would be deleted"
    );
  });

  it("--finish --apply deletes, and exits 1 when a delete failed", async () => {
    state.failed = true;
    const { io } = capture();
    expect(await runRemarkCommand(["--finish", "--apply"], io)).toBe(1);
    expect(state.finish).toEqual([{ apply: true }]);
  });

  it("refuses --finish with --step", async () => {
    const { err, io } = capture();
    expect(
      await runRemarkCommand(["--finish", "--step", "woodpecker"], io)
    ).toBe(1);
    expect(state.finish).toEqual([]);
    expect(err.join("\n")).toContain("--finish takes no --step");
  });

  it("parses its arguments", () => {
    expect(parseRemarkArgs(["--apply", "--step", "ssh"])).toEqual({
      apply: true,
      finish: false,
      steps: ["ssh"],
    });
    expect(parseRemarkArgs(["--step"])).toBeNull();
    expect(parseRemarkArgs(["--bogus"])).toBeNull();
  });
});
