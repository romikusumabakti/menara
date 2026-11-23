import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The per-user, per-client MCP quota (lib/mcp/rate-limit): a fixed 60 s
// window counted in Valkey, 120 reads and 20 writes. A Valkey that cannot
// answer lets the call through (the limit is not an availability gate) and
// says so once in the log.

const { consumeMcpQuota, setRateLimitConnectionForTests } = await import(
  "@/lib/mcp/rate-limit"
);

/** A Valkey stand-in: INCR and EXPIRE in a MULTI, on an in-memory map. */
function fakeValkey() {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    counts,
    ttls,
    multi() {
      const ops: (() => [null, number])[] = [];
      const chain = {
        incr(key: string) {
          ops.push(() => {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return [null, next];
          });
          return chain;
        },
        expire(key: string, seconds: number) {
          ops.push(() => {
            ttls.set(key, seconds);
            return [null, 1];
          });
          return chain;
        },
        exec: async () => ops.map((op) => op()),
      };
      return chain;
    },
  };
}

const USER = "01900000-0000-7000-8000-0000000000a1";
const OTHER_USER = "01900000-0000-7000-8000-0000000000a2";
const CLIENT = "https://agent.example.com/oauth/client.json";
const OTHER_CLIENT = "https://other.example.com/oauth/client.json";

// 12:00:15 UTC: 45 s left in the window.
const NOW = new Date("2026-11-24T12:00:15Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  setRateLimitConnectionForTests(undefined);
  vi.restoreAllMocks();
});

async function consumeTimes(
  n: number,
  kind: "read" | "write",
  user = USER,
  client = CLIENT
) {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await consumeMcpQuota(user, client, kind));
  }
  return results;
}

describe("consumeMcpQuota", () => {
  it("allows 120 reads then 429 with Retry-After", async () => {
    const valkey = fakeValkey();
    setRateLimitConnectionForTests(valkey);
    const allowed = await consumeTimes(120, "read");
    expect(allowed.every((r) => r.ok)).toBe(true);
    expect(await consumeMcpQuota(USER, CLIENT, "read")).toEqual({
      ok: false,
      retryAfterSeconds: 45,
    });
    const minute = Math.floor(NOW.getTime() / 60_000);
    const key = `mcp:rl:read:${USER}:${CLIENT}:${minute}`;
    expect(valkey.counts.get(key)).toBe(121);
    expect(valkey.ttls.get(key)).toBe(120);

    // The next window starts afresh.
    vi.setSystemTime(new Date("2026-11-24T12:01:00Z"));
    expect(await consumeMcpQuota(USER, CLIENT, "read")).toEqual({ ok: true });
  });

  it("allows 20 writes then 429", async () => {
    setRateLimitConnectionForTests(fakeValkey());
    const allowed = await consumeTimes(20, "write");
    expect(allowed.every((r) => r.ok)).toBe(true);
    expect(await consumeMcpQuota(USER, CLIENT, "write")).toMatchObject({
      ok: false,
    });
    // Reads have their own counter.
    expect(await consumeMcpQuota(USER, CLIENT, "read")).toEqual({ ok: true });
  });

  it("counts per user and client separately", async () => {
    setRateLimitConnectionForTests(fakeValkey());
    await consumeTimes(20, "write");
    expect((await consumeMcpQuota(USER, CLIENT, "write")).ok).toBe(false);
    expect(await consumeMcpQuota(OTHER_USER, CLIENT, "write")).toEqual({
      ok: true,
    });
    expect(await consumeMcpQuota(USER, OTHER_CLIENT, "write")).toEqual({
      ok: true,
    });
  });

  it("fails open when Valkey is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setRateLimitConnectionForTests({
      multi: () => {
        const chain = {
          incr: () => chain,
          expire: () => chain,
          exec: async () => {
            throw new Error("Connection is closed.");
          },
        };
        return chain;
      },
    });
    const results = await consumeTimes(30, "write");
    expect(results.every((r) => r.ok)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("fails open without REDIS_URL", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("REDIS_URL", "");
    setRateLimitConnectionForTests(undefined);
    expect(await consumeMcpQuota(USER, CLIENT, "write")).toEqual({ ok: true });
    expect(await consumeMcpQuota(USER, CLIENT, "write")).toEqual({ ok: true });
    expect(error).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
