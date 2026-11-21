import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hits: [] as unknown[] }));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/sweep/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sweep/run")>();
  return {
    ...actual,
    runSweep: vi.fn(async () => ({
      hits: state.hits,
      failed: state.hits.length > 0,
    })),
  };
});

const { runSweepCommand } = await import("@/scripts/cli/sweep");

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
  state.hits = [];
  vi.stubEnv("MENARA_LEGACY_NAME", "oldtool");
});
afterEach(() => vi.unstubAllEnvs());

describe("menara sweep", () => {
  it("exits 0 when clean", async () => {
    const c = capture();
    expect(await runSweepCommand([], c.io)).toBe(0);
  });

  it("prints --json output and exits 1 on a hit", async () => {
    state.hits = [{ system: "ssh", location: "servers/s1", excerpt: "x" }];
    const c = capture();
    expect(await runSweepCommand(["--json"], c.io)).toBe(1);
    expect(JSON.parse(c.out.join("\n"))).toEqual(state.hits);
  });

  it("exits 2 without legacy config and 1 on bad arguments", async () => {
    vi.stubEnv("MENARA_LEGACY_NAME", "");
    const c = capture();
    expect(await runSweepCommand([], c.io)).toBe(2);
    vi.stubEnv("MENARA_LEGACY_NAME", "oldtool");
    expect(await runSweepCommand(["--apply"], c.io)).toBe(1);
  });
});
