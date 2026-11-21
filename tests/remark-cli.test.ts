import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as { apply: boolean; steps?: readonly string[] }[],
  failed: false,
}));

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
              available: true,
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

  it("refuses an unknown or not yet available step", async () => {
    const { err, io } = capture();
    expect(await runRemarkCommand(["--step", "nope"], io)).toBe(1);
    expect(await runRemarkCommand(["--step", "jira"], io)).toBe(1);
    expect(state.calls).toEqual([]);
    expect(err.join("\n")).toContain("jira is not available yet");
  });

  it("refuses --finish for now", async () => {
    const { err, io } = capture();
    expect(await runRemarkCommand(["--finish"], io)).toBe(1);
    expect(state.calls).toEqual([]);
    expect(err.join("\n")).toContain("--finish is not available yet");
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
