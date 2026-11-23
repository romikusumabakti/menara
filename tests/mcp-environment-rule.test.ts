import { beforeEach, describe, expect, it, vi } from "vitest";

// Which environments an agent may deploy to or roll back (lib/mcp
// /environment-rule): dev, qa and sandbox only; everything else, including an
// environment nobody classified yet, is read-only for agents.

const ENV_ID = "01900000-0000-7000-8000-000000001001";
const state = vi.hoisted(() => ({ rows: [] as { kind: string | null }[] }));

vi.mock("@/lib/db", () => {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => query,
    // biome-ignore lint/suspicious/noThenProperty: a drizzle query is thenable.
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
      Promise.resolve(state.rows).then(resolve, reject),
  };
  return { db: { select: () => query } };
});

const { agentMayWrite, assertAgentWritableEnvironment } = await import(
  "@/lib/mcp/environment-rule"
);
const { CodedHTTPException } = await import("@/server/errors");

beforeEach(() => {
  state.rows = [];
});

describe("agentMayWrite", () => {
  it.each([
    ["dev", true],
    ["qa", true],
    ["sandbox", true],
    ["release", false],
    ["prod", false],
    ["demo", false],
    [null, false],
  ] as const)("%s → %s", (kind, expected) => {
    expect(agentMayWrite(kind)).toBe(expected);
  });
});

describe("assertAgentWritableEnvironment", () => {
  it("passes a qa environment", async () => {
    state.rows = [{ kind: "qa" }];
    await expect(assertAgentWritableEnvironment(ENV_ID)).resolves.toBe(
      undefined
    );
  });

  it.each([
    ["prod", "prod"],
    ["release", "release"],
    [null, "unset"],
  ])("refuses %s with mcpEnvironmentReadOnly", async (kind, param) => {
    state.rows = [{ kind }];
    const error = await assertAgentWritableEnvironment(ENV_ID).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(CodedHTTPException);
    expect(error).toMatchObject({
      status: 409,
      code: "mcpEnvironmentReadOnly",
      params: { kind: param },
    });
  });

  it("refuses an environment it cannot find (fail closed)", async () => {
    await expect(assertAgentWritableEnvironment(ENV_ID)).rejects.toMatchObject({
      code: "mcpEnvironmentReadOnly",
      params: { kind: "unset" },
    });
  });
});
