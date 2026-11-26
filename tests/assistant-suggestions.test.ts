import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttentionGroup,
  MyIssue,
  RecentEnvironment,
} from "@/lib/home/queries";

const state = vi.hoisted(() => ({
  signedIn: true,
  attention: [] as unknown[],
  issues: { items: [], total: 0 } as { items: unknown[]; total: number },
  recent: [] as unknown[],
}));

vi.mock("@/lib/auth-session", async () => {
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireSession: vi.fn(async () => {
      if (!state.signedIn) throw new HTTPException(401);
      return { user: { id: "user-1", role: "qa" } };
    }),
  };
});
vi.mock("@/lib/home/queries", () => ({
  getAttentionGroups: vi.fn(async () => state.attention),
  listMyOpenIssues: vi.fn(async () => state.issues),
  listRecentEnvironments: vi.fn(async () => state.recent),
}));
const { buildSuggestions } = await import("@/lib/assistant/suggestions");

const group = (over: Partial<AttentionGroup> = {}): AttentionGroup =>
  ({
    key: "deploy",
    environmentId: "env-a",
    environmentName: "ACME · Dev",
    envPath: "/ACME/dev",
    projectId: "proj-a",
    count: 1,
    canAcknowledge: true,
    latest: {
      id: "run-1",
      kind: "deploy",
      description: "Deploy",
      errorMessage: null,
      runAt: new Date("2026-11-25T10:00:00Z"),
    },
    ...over,
  }) as AttentionGroup;

const issue = (number: number): MyIssue => ({
  id: `i-${number}`,
  number,
  title: "Fix it",
  status: "open",
  projectKey: "ACME",
  projectName: "ACME",
  canWrite: true,
});

const env = (
  id: string,
  name: string,
  projectName = "BETA"
): RecentEnvironment => ({
  id,
  name,
  path: `/${projectName}/${name}`,
  projectId: "proj-b",
  projectName,
  hasDatabase: false,
  canBackup: false,
});

const empty = {
  attention: [],
  myIssues: { items: [], total: 0 },
  recentEnvironments: [],
};

describe("buildSuggestions", () => {
  it("falls back to the two general questions", () => {
    expect(buildSuggestions(empty)).toEqual([
      { kind: "general", params: { question: "changedToday" }, context: null },
      {
        kind: "general",
        params: { question: "failedDeploysThisWeek" },
        context: null,
      },
    ]);
  });

  it("orders failedRun, myIssues, environment, general and caps at 4", () => {
    const out = buildSuggestions({
      attention: [group()],
      myIssues: { items: [issue(7), issue(8)], total: 5 },
      recentEnvironments: [env("env-b", "UAT")],
    });
    expect(out).toEqual([
      {
        kind: "failedRun",
        params: { runKind: "deploy", environment: "ACME · Dev" },
        context: { kind: "environment", id: "env-a" },
      },
      {
        kind: "myIssues",
        params: { count: 5, firstKey: "ACME-7" },
        context: null,
      },
      {
        kind: "environment",
        params: { environment: "BETA · UAT" },
        context: { kind: "environment", id: "env-b" },
      },
      { kind: "general", params: { question: "changedToday" }, context: null },
    ]);
  });

  it("uses the most recent attention group", () => {
    const older = group({
      environmentId: "env-o",
      environmentName: "ACME · Old",
    });
    older.latest = { ...older.latest, runAt: new Date("2026-11-20T00:00:00Z") };
    const out = buildSuggestions({ ...empty, attention: [older, group()] });
    expect(out[0]?.context).toEqual({ kind: "environment", id: "env-a" });
  });

  it("skips the environment already used by the failed run", () => {
    const out = buildSuggestions({
      ...empty,
      attention: [group()],
      recentEnvironments: [env("env-a", "Dev", "ACME"), env("env-b", "UAT")],
    });
    const envs = out.filter((s) => s.kind === "environment");
    expect(envs).toHaveLength(1);
    expect(envs[0]?.context?.id).toBe("env-b");
  });

  it("has no duplicates and leaves out absent kinds", () => {
    const out = buildSuggestions({
      ...empty,
      myIssues: { items: [issue(1)], total: 1 },
    });
    expect(out.map((s) => s.kind)).toEqual(["myIssues", "general", "general"]);
    expect(new Set(out.map((s) => JSON.stringify(s))).size).toBe(out.length);
  });
});

describe("GET /api/assistant/suggestions", () => {
  beforeEach(() => {
    state.signedIn = true;
    state.attention = [];
    state.issues = { items: [], total: 0 };
    state.recent = [];
  });

  const get = async () => {
    const { assistantRouter } = await import("@/server/routes/assistant");
    const { HTTPException } = await import("hono/http-exception");
    const app = new Hono()
      .onError((e, c) =>
        e instanceof HTTPException ? e.getResponse() : c.text("error", 500)
      )
      .route("/api/assistant", assistantRouter);
    return app.request("/api/assistant/suggestions");
  };

  it("requires a session", async () => {
    state.signedIn = false;
    expect((await get()).status).toBe(401);
  });

  it("returns items built from the caller's queries", async () => {
    state.issues = { items: [issue(3)], total: 1 };
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { kind: string }[] };
    expect(body.items.map((s) => s.kind)).toEqual([
      "myIssues",
      "general",
      "general",
    ]);
  });
});
