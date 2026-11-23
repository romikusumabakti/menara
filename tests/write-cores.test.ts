import { readFileSync } from "node:fs";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@/lib/access-scope";

// The scope-taking write cores (server/services/issues.ts, deploys.ts): the
// MCP tools call them with a scope built from an OAuth token, so they decide
// on the scope and never read the request session. The HTTP routes keep
// calling the session wrappers, which must produce the same rows.

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const OTHER_PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f2";
const ISSUE_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const BUILD_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const TAG = "origin-acme-development-abc1234";
const PREVIOUS_TAG = "origin-acme-development-0000001";

const session = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => {
    session.calls += 1;
    return {
      user: { id: USER_ID, role: "admin" },
      session: { signInMethod: "passkey" },
    };
  }),
  getServerSession: vi.fn(async () => null),
}));

const activity = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (row: unknown) => {
    activity.rows.push(row);
  }),
}));

vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue")>()),
  enqueue: vi.fn(async () => {}),
}));
vi.mock("@/lib/notifications", () => ({
  notifyIssueAssigned: vi.fn(async () => {}),
  notifyIssueMention: vi.fn(async () => {}),
}));
vi.mock("@/lib/issue-number", () => ({
  insertIssueWithNextNumber: vi.fn(
    async (_tx: unknown, projectId: string, values: { title: string }) => ({
      id: ISSUE_ID,
      projectId,
      number: 7,
      ...values,
    })
  ),
}));

// A table-keyed stand-in for the database: every select resolves to the
// table's rows, filters ignored (each test names one project and one issue).
vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const rowsOf = (table: unknown): unknown[] => {
    if (table === schema.projects) return [{ id: PROJECT_ID, key: "ACME" }];
    if (table === schema.projectMembers) return [];
    if (table === schema.issues) return [{ projectId: PROJECT_ID }];
    if (table === schema.environments) return [{ projectId: PROJECT_ID }];
    return [];
  };
  const selectFrom = (table: unknown) => {
    const query = {
      where: () => query,
      limit: () => query,
      innerJoin: () => query,
      // biome-ignore lint/suspicious/noThenProperty: a drizzle query is thenable.
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        Promise.resolve(rowsOf(table)).then(resolve, reject),
    };
    return query;
  };
  const db = {
    select: () => ({ from: selectFrom }),
    insert: () => ({
      values: () => ({ returning: async () => [{ id: "comment-1" }] }),
    }),
    transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        delete: () => ({ where: async () => {} }),
        insert: () => ({ values: async () => {} }),
      }),
    query: {
      issues: {
        findFirst: async () => ({
          number: 7,
          title: "Login fails",
          projectId: PROJECT_ID,
          project: { key: "ACME" },
        }),
      },
    },
  };
  return { db };
});

const repo = vi.hoisted(() => ({
  getTarget: vi.fn(),
  getTagState: vi.fn(),
  findBuild: vi.fn(),
  getDeployLock: vi.fn(),
  getEnvironmentForLock: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deploy/repository")>()),
  ...repo,
}));

const deployments = vi.hoisted(() => ({ requestDeployment: vi.fn() }));
vi.mock("@/server/services/deployments", () => deployments);

const { createIssue, createIssueFor, addCommentFor } = await import(
  "@/server/services/issues"
);
const { setIssueLabels, setIssueLabelsFor } = await import(
  "@/server/services/labels"
);
const { deployTag, deployTagFor, rollbackTargetFor } = await import(
  "@/server/services/deploys"
);

const engineerScope: AccessScope = {
  userId: USER_ID,
  orgRole: "engineer",
  projectRoles: { [PROJECT_ID]: "engineer" },
  seesAllProjects: false,
};
const via = { client: "Acme Agent", clientId: "https://example.com/client" };

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof HTTPException) {
      return { status: error.status, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "registry.example.com:5000");
  session.calls = 0;
  activity.rows = [];
  repo.getTarget.mockResolvedValue({
    id: TARGET_ID,
    environmentId: ENV_ID,
    componentKey: "acme-accounting",
    sourceBranch: "acme/development",
  });
  repo.getDeployLock.mockResolvedValue(null);
  repo.getEnvironmentForLock.mockResolvedValue({
    id: ENV_ID,
    name: "Acme Dev",
    ownerId: null,
  });
  repo.findBuild.mockImplementation(async (_app: string, tag: string) =>
    tag === TAG
      ? { id: BUILD_ID, tag, branch: "acme/development" }
      : tag === "origin-main-1111111"
        ? { id: "other", tag, branch: "main" }
        : null
  );
  repo.getTagState.mockResolvedValue({
    currentTag: TAG,
    currentStatus: "success",
    previousTag: PREVIOUS_TAG,
  });
  deployments.requestDeployment.mockResolvedValue({
    deploymentId: "dep-1",
    runId: "run-1",
    status: "queued",
  });
});

const newIssue = { projectId: PROJECT_ID, title: "Login fails" };

describe("issue write cores", () => {
  it("createIssueFor checks issue:write on the scope, not a session", async () => {
    const outsider: AccessScope = {
      ...engineerScope,
      projectRoles: { [OTHER_PROJECT_ID]: "engineer" },
    };
    expect((await refusal(createIssueFor(outsider, newIssue))).status).toBe(
      404
    );
    const viewer: AccessScope = {
      ...engineerScope,
      projectRoles: { [PROJECT_ID]: "viewer" },
    };
    expect((await refusal(createIssueFor(viewer, newIssue))).status).toBe(403);
    expect(session.calls).toBe(0);
    expect(activity.rows).toEqual([]);
  });

  it("the HTTP wrapper and the core produce the same issue.created row", async () => {
    expect((await createIssue(newIssue)).success).toBe(true);
    const fromWrapper = activity.rows.splice(0);
    expect(session.calls).toBeGreaterThan(0);
    expect((await createIssueFor(engineerScope, newIssue)).success).toBe(true);
    expect(activity.rows).toEqual(fromWrapper);
    expect(fromWrapper).toEqual([
      {
        actorId: USER_ID,
        action: "issue.created",
        entityType: "issue",
        entityId: ISSUE_ID,
        data: { key: "ACME-7", title: "Login fails" },
      },
    ]);
  });

  it("addCommentFor records issue.commented with viaClient", async () => {
    expect(
      await addCommentFor(engineerScope, ISSUE_ID, " Looks fixed ", via)
    ).toEqual({ success: true });
    expect(activity.rows).toEqual([
      {
        actorId: USER_ID,
        action: "issue.commented",
        entityType: "issue",
        entityId: ISSUE_ID,
        data: {
          key: "ACME-7",
          viaClient: "Acme Agent",
          viaClientId: "https://example.com/client",
        },
      },
    ]);
    expect(session.calls).toBe(0);
  });
});

describe("label write core", () => {
  it("setIssueLabelsFor records issue.labelsChanged with viaClient", async () => {
    expect(
      await setIssueLabelsFor(engineerScope, ISSUE_ID, ["label-1"], via)
    ).toEqual({ success: true });
    expect(activity.rows).toEqual([
      {
        actorId: USER_ID,
        action: "issue.labelsChanged",
        entityType: "issue",
        entityId: ISSUE_ID,
        data: {
          key: "ACME-7",
          viaClient: "Acme Agent",
          viaClientId: "https://example.com/client",
        },
      },
    ]);
    expect(session.calls).toBe(0);
  });

  it("the HTTP wrapper records the same row without a client", async () => {
    expect(await setIssueLabels(ISSUE_ID, [])).toEqual({ success: true });
    expect(activity.rows).toEqual([
      {
        actorId: USER_ID,
        action: "issue.labelsChanged",
        entityType: "issue",
        entityId: ISSUE_ID,
        data: { key: "ACME-7" },
      },
    ]);
  });
});

describe("deploy write cores", () => {
  it("deployTagFor refuses a locked environment with the lock message", async () => {
    repo.getDeployLock.mockResolvedValue({
      environmentId: ENV_ID,
      lockedBy: USER_ID,
      lockerName: "Owner Olga",
      reason: "UAT with the client",
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
    });
    const refused = await refusal(
      deployTagFor(engineerScope, TARGET_ID, TAG, via)
    );
    expect(refused.status).toBe(409);
    expect(refused.message).toContain("Owner Olga");
    expect(refused.message).toContain("UAT with the client");
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
    expect(activity.rows).toEqual([]);
  });

  it("deployTagFor refuses a tag not on the target branch with 404", async () => {
    const refused = await refusal(
      deployTagFor(engineerScope, TARGET_ID, "origin-main-1111111")
    );
    expect(refused).toEqual({ status: 404, message: "Build not found" });
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("rollbackTargetFor refuses a target without previousTag with 409", async () => {
    repo.getTagState.mockResolvedValue({
      currentTag: TAG,
      currentStatus: "success",
      previousTag: null,
    });
    const refused = await refusal(rollbackTargetFor(engineerScope, TARGET_ID));
    expect(refused).toEqual({
      status: 409,
      message: "No previous successful deploy",
    });
    expect(activity.rows).toEqual([]);
  });

  it("deployTagFor and rollbackTargetFor record the request with viaClient", async () => {
    expect(await deployTagFor(engineerScope, TARGET_ID, TAG, via)).toEqual({
      deploymentId: "dep-1",
      runId: "run-1",
    });
    expect(await rollbackTargetFor(engineerScope, TARGET_ID, via)).toEqual({
      deploymentId: "dep-1",
      runId: "run-1",
    });
    const viaData = {
      viaClient: "Acme Agent",
      viaClientId: "https://example.com/client",
    };
    expect(activity.rows).toEqual([
      {
        actorId: USER_ID,
        action: "deploy.requested",
        entityType: "environment",
        entityId: ENV_ID,
        data: {
          environment: "Acme Dev",
          target: "acme-accounting",
          tag: TAG,
          ...viaData,
        },
      },
      {
        actorId: USER_ID,
        action: "deploy.rollbackRequested",
        entityType: "environment",
        entityId: ENV_ID,
        data: {
          environment: "Acme Dev",
          target: "acme-accounting",
          tag: PREVIOUS_TAG,
          ...viaData,
        },
      },
    ]);
    expect(deployments.requestDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "rollback", tag: PREVIOUS_TAG })
    );
    expect(session.calls).toBe(0);
  });

  it("deploy.requested is recorded for a UI deploy too", async () => {
    await deployTag(TARGET_ID, TAG);
    expect(session.calls).toBeGreaterThan(0);
    expect(activity.rows).toEqual([
      {
        actorId: USER_ID,
        action: "deploy.requested",
        entityType: "environment",
        entityId: ENV_ID,
        data: { environment: "Acme Dev", target: "acme-accounting", tag: TAG },
      },
    ]);
  });
});

describe("activity feed", () => {
  it("the activity feed renders deploy.requested, deploy.rollbackRequested, issue.commented, issue.labelsChanged and the via suffix", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    expect(page).toMatch(
      /case "deploy\.requested":\s*return t\("deployRequested"/
    );
    expect(page).toMatch(
      /case "deploy\.rollbackRequested":\s*return t\("deployRollbackRequested"/
    );
    expect(page).toMatch(
      /case "issue\.commented":\s*return t\("issueCommented"/
    );
    expect(page).toMatch(
      /case "issue\.labelsChanged":\s*return t\("issueLabelsChanged"/
    );
    expect(page).toMatch(/t\("viaClient", \{/);
    for (const locale of ["ar", "en", "es", "id", "zh"]) {
      const messages = JSON.parse(
        readFileSync(`messages/${locale}.json`, "utf8")
      ).activity;
      for (const key of [
        "deployRequested",
        "deployRollbackRequested",
        "issueCommented",
        "issueLabelsChanged",
        "viaClient",
      ]) {
        expect(messages[key], `${locale} activity.${key}`).toBeTruthy();
      }
      expect(messages.viaClient).toContain("{message}");
      expect(messages.viaClient).toContain("{client}");
    }
  });
});
