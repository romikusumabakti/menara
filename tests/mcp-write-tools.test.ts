import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@/lib/access-scope";

// The MCP write tools (lib/mcp/write-tools) through /api/mcp: listed only
// with their scope, names resolved inside the viewer's scope, the agent
// environment rule before every deploy and rollback, and every refusal of a
// core returned as a tool error with a stable code. The issue cores are
// stubbed (their own suite covers them); the deploy cores run for real on a
// stubbed deploy repository, so their permission checks and refusals are the
// ones the UI gets.

const ISSUER = "https://app.example.net/api/auth";
const RESOURCE = "https://app.example.net/api/mcp";
const HOST = "app.example.net";
const CLIENT_ID = "https://agent.example.com/oauth/client.json";
const USER_ID = "01900000-0000-7000-8000-0000000000a1";
const ASSIGNEE_ID = "01900000-0000-7000-8000-0000000000a2";
const ACME_ID = "01900000-0000-7000-8000-000000000001";
const BETA_ID = "01900000-0000-7000-8000-000000000002";
const ENV_ID = "01900000-0000-7000-8000-000000001001";
const TARGET_ID = "01900000-0000-7000-8000-000000002001";
const BUILD_ID = "01900000-0000-7000-8000-000000003001";
const ISSUE_ID = "01900000-0000-7000-8000-000000004001";
const LABEL_BUG = "01900000-0000-7000-8000-000000005001";
const LABEL_INFRA = "01900000-0000-7000-8000-000000005002";
const TAG = "origin-acme-development-abc1234";
const PREVIOUS_TAG = "origin-acme-development-0000001";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  jwks: { keys: [] as unknown[] },
  grantScopes: [] as string[],
  scope: null as AccessScope | null,
  tables: new Map<unknown, Row[]>(),
  activity: [] as Row[],
}));

vi.mock("@/lib/auth", () => {
  const jwtPlugin = {
    id: "jwt",
    options: {},
    endpoints: { getJwks: async () => state.jwks },
  };
  const context = {
    baseURL: ISSUER,
    getPlugin: (id: string) => (id === "jwt" ? jwtPlugin : undefined),
    adapter: {},
    internalAdapter: { reserveVerificationValue: vi.fn() },
    options: {},
  };
  return {
    auth: {
      options: {},
      $context: Promise.resolve(context),
      api: { getSession: vi.fn() },
    },
  };
});

// A table-keyed stand-in for the database: a select resolves to the rows the
// test put under its table, filters ignored.
vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const rowsOf = (table: unknown): unknown[] => {
    if (table === schema.instanceSettings) return [{ enabled: true }];
    if (table === schema.oauthConsents) {
      return [
        {
          scopes: state.grantScopes,
          clientName: "Acme Agent",
          disabled: false,
          approvedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ];
    }
    return state.tables.get(table) ?? [];
  };
  const selectFrom = (table: unknown) => {
    const query = {
      innerJoin: () => query,
      leftJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      // biome-ignore lint/suspicious/noThenProperty: a drizzle query is thenable.
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        Promise.resolve(rowsOf(table)).then(resolve, reject),
    };
    return query;
  };
  const insert = () => ({
    values: () => ({ onConflictDoUpdate: async () => {} }),
  });
  return {
    db: { select: () => ({ from: selectFrom }), insert },
    pgClient: vi.fn(),
  };
});

vi.mock("@/lib/assistant/viewer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/assistant/viewer")>();
  const entry = (id: string, key: string) => ({
    id,
    key,
    name: key,
    group: null,
    description: null,
  });
  return {
    ...actual,
    loadAssistantViewer: vi.fn(async () =>
      actual.buildAssistantViewer(state.scope as AccessScope)
    ),
    loadProjectEntries: vi.fn(async () => [
      entry(ACME_ID, "ACME"),
      entry(BETA_ID, "BETA"),
    ]),
  };
});

vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (row: Row) => {
    state.activity.push(row);
  }),
}));

const issueCores = vi.hoisted(() => ({
  createIssueFor: vi.fn(),
  updateIssueFor: vi.fn(),
  addCommentFor: vi.fn(),
}));
vi.mock("@/server/services/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/issues")>()),
  ...issueCores,
}));

const labelCores = vi.hoisted(() => ({ setIssueLabelsFor: vi.fn() }));
vi.mock("@/server/services/labels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/labels")>()),
  ...labelCores,
}));

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

// The slug resolver (current slug, then a renamed one's alias) on the
// environment rows of the test.
vi.mock("@/lib/environment-slug", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/environment-slug")>();
  const { environments } = await import("@/lib/db/schema");
  return {
    ...actual,
    resolveEnvironmentBySlug: vi.fn(async (projectId: string, slug: string) => {
      const row = (state.tables.get(environments) ?? []).find(
        (e) => e.projectId === projectId && e.slug === slug.toLowerCase()
      );
      if (!row) return null;
      const environment = {
        id: row.id as string,
        projectId: row.projectId as string,
        slug: row.slug as string,
      };
      return { environment, canonicalSlug: environment.slug, viaAlias: false };
    }),
  };
});

const deployments = vi.hoisted(() => ({ requestDeployment: vi.fn() }));
vi.mock("@/server/services/deployments", () => deployments);

const schema = await import("@/lib/db/schema");
const { createBaseApp } = await import("@/server/app");
const { mcpRouter } = await import("@/server/routes/mcp");
const { invalidateMcpEnabled } = await import("@/lib/mcp/config");
const { resetGrantUsageThrottle } = await import("@/lib/mcp/gate");
const { setRateLimitConnectionForTests } = await import("@/lib/mcp/rate-limit");

const app = createBaseApp().route("/api/mcp", mcpRouter);

let signingKey: CryptoKey;
const KID = "test-key";

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  state.jwks = { keys: [{ ...jwk, kid: KID, alg: "ES256", use: "sig" }] };
});

function scopeAs(role: "engineer" | "qa"): AccessScope {
  return {
    userId: USER_ID,
    orgRole: role,
    projectRoles: { [ACME_ID]: role },
    seesAllProjects: false,
  };
}

const ALL_SCOPES = "read issues:write deploys:write";

function environmentRow(kind: string | null): Row {
  return { id: ENV_ID, projectId: ACME_ID, slug: "qa", kind };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "registry.example.com:5000");
  // No Valkey in this suite: the limiter fails open (its own suite covers it).
  vi.stubEnv("REDIS_URL", "");
  setRateLimitConnectionForTests(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  state.scope = scopeAs("engineer");
  state.grantScopes = ["read", "issues:write", "deploys:write"];
  state.activity = [];
  state.tables = new Map<unknown, Row[]>([
    [schema.environments, [environmentRow("qa")]],
    [schema.deployTargets, [{ id: TARGET_ID, componentKey: "acme-api" }]],
    [
      schema.labels,
      [
        { id: LABEL_BUG, name: "bug" },
        { id: LABEL_INFRA, name: "infra" },
      ],
    ],
    [schema.users, [{ id: ASSIGNEE_ID, email: "dev@example.com" }]],
    [schema.issues, [{ id: ISSUE_ID, number: 12 }]],
  ]);
  invalidateMcpEnabled();
  resetGrantUsageThrottle();

  repo.getTarget.mockResolvedValue({
    id: TARGET_ID,
    environmentId: ENV_ID,
    componentKey: "acme-api",
    sourceBranch: "acme/development",
  });
  repo.getDeployLock.mockResolvedValue(null);
  repo.getEnvironmentForLock.mockResolvedValue({
    id: ENV_ID,
    name: "Acme QA",
    ownerId: null,
  });
  repo.findBuild.mockImplementation(async (_component: string, tag: string) =>
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
  issueCores.createIssueFor.mockResolvedValue({
    success: true,
    data: {
      id: ISSUE_ID,
      number: 13,
      title: "Login fails",
      status: "open",
      type: "bug",
      priority: "high",
    },
  });
  issueCores.updateIssueFor.mockResolvedValue({
    success: true,
    data: {
      id: ISSUE_ID,
      number: 12,
      title: "Login fails",
      status: "open",
      type: "bug",
      priority: "high",
    },
  });
  issueCores.addCommentFor.mockResolvedValue({ success: true });
  labelCores.setIssueLabelsFor.mockResolvedValue({ success: true });
});

async function token(scope = ALL_SCOPES): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ azp: CLIENT_ID, scope })
    .setProtectedHeader({ alg: "ES256", kid: KID, typ: "at+jwt" })
    .setSubject(USER_ID)
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setJti(crypto.randomUUID())
    .sign(signingKey);
}

async function connect(scope = ALL_SCOPES): Promise<Client> {
  const bearer = await token(scope);
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", HOST);
      headers.set("authorization", `Bearer ${bearer}`);
      return app.request(String(input), { ...init, headers });
    },
  });
  const client = new Client(
    { name: "acme-test-agent", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await client.connect(transport);
  return client;
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

async function call(
  name: string,
  args: Record<string, unknown>,
  scope = ALL_SCOPES
): Promise<ToolResult> {
  const client = await connect(scope);
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await client.close();
  }
}

const textOf = (result: ToolResult) =>
  result.content.map((c) => c.text ?? "").join("\n");

const WRITE_TOOLS = [
  "create_issue",
  "update_issue",
  "add_issue_comment",
  "deploy",
  "rollback",
];

const deployArgs = {
  projectKey: "ACME",
  environmentSlug: "qa",
  component: "acme-api",
  tag: TAG,
};

describe("MCP write tools", () => {
  it("hides write tools without their scope", async () => {
    const names = async (scope: string) => {
      const client = await connect(scope);
      try {
        return (await client.listTools()).tools.map((t) => t.name);
      } finally {
        await client.close();
      }
    };
    const readOnly = await names("read");
    for (const tool of WRITE_TOOLS) expect(readOnly).not.toContain(tool);

    const issues = await names("read issues:write");
    expect(issues).toEqual(
      expect.arrayContaining([
        "create_issue",
        "update_issue",
        "add_issue_comment",
      ])
    );
    expect(issues).not.toContain("deploy");
    expect(issues).not.toContain("rollback");

    const deploys = await names("read deploys:write");
    expect(deploys).toEqual(expect.arrayContaining(["deploy", "rollback"]));
    expect(deploys).not.toContain("create_issue");

    // A scope the token carries but the grant no longer holds hides them too.
    state.grantScopes = ["read"];
    const revoked = await names(ALL_SCOPES);
    for (const tool of WRITE_TOOLS) expect(revoked).not.toContain(tool);

    // A write call outside the scope is not executed: the tool does not
    // exist for this token.
    await expect(call("deploy", deployArgs, "read")).rejects.toThrow(
      /Tool deploy not found/
    );
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("refuses deploy on a release/prod/demo/unset environment with mcpEnvironmentReadOnly", async () => {
    for (const [kind, param] of [
      ["release", "release"],
      ["prod", "prod"],
      ["demo", "demo"],
      [null, "unset"],
    ] as const) {
      state.tables.set(schema.environments, [environmentRow(kind)]);
      const deploy = await call("deploy", deployArgs);
      expect(deploy.isError).toBe(true);
      expect(deploy.structuredContent).toEqual({
        code: "mcpEnvironmentReadOnly",
        params: { kind: param },
      });
      expect(textOf(deploy)).toMatch(/^mcpEnvironmentReadOnly: /);

      const rollback = await call("rollback", {
        projectKey: "ACME",
        environmentSlug: "qa",
        component: "acme-api",
      });
      expect(rollback.isError).toBe(true);
      expect(rollback.structuredContent).toMatchObject({
        code: "mcpEnvironmentReadOnly",
      });
    }
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
    expect(state.activity).toEqual([]);
  });

  it("deploys on qa and records deploy.requested with viaClient", async () => {
    const result = await call("deploy", deployArgs);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      deploymentId: "dep-1",
      runId: "run-1",
    });
    expect(deployments.requestDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID,
        tag: TAG,
        userId: USER_ID,
      })
    );
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: USER_ID,
        action: "deploy.requested",
        data: expect.objectContaining({
          tag: TAG,
          viaClient: "Acme Agent",
          viaClientId: CLIENT_ID,
        }),
      }),
    ]);

    const rollback = await call("rollback", {
      projectKey: "ACME",
      environmentSlug: "qa",
      component: "acme-api",
    });
    expect(rollback.isError).toBeFalsy();
    expect(state.activity[1]).toMatchObject({
      action: "deploy.rollbackRequested",
      data: { tag: PREVIOUS_TAG, viaClient: "Acme Agent" },
    });
  });

  it("refuses deploy for a role without deploy:run as a tool error", async () => {
    state.scope = scopeAs("qa");
    const result = await call("deploy", deployArgs);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "forbidden" });
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("refuses a tag not on the branch and a target without previousTag as tool errors with stable codes", async () => {
    const offBranch = await call("deploy", {
      ...deployArgs,
      tag: "origin-main-1111111",
    });
    expect(offBranch.isError).toBe(true);
    expect(offBranch.structuredContent).toEqual({
      code: "buildNotFound",
      params: {},
    });
    expect(textOf(offBranch)).toBe("buildNotFound: Build not found");

    repo.getTagState.mockResolvedValue({
      currentTag: TAG,
      currentStatus: "success",
      previousTag: null,
    });
    const rollback = await call("rollback", {
      projectKey: "ACME",
      environmentSlug: "qa",
      component: "acme-api",
    });
    expect(rollback.isError).toBe(true);
    expect(rollback.structuredContent).toEqual({
      code: "noPreviousDeploy",
      params: {},
    });
    expect(textOf(rollback)).toBe(
      "noPreviousDeploy: No previous successful deploy"
    );
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("names the valid environments and components of an unknown one", async () => {
    const env = await call("deploy", { ...deployArgs, environmentSlug: "qa9" });
    expect(env.isError).toBe(true);
    expect(env.structuredContent).toMatchObject({
      code: "unknownEnvironment",
      params: { name: "qa9", valid: ["qa"] },
    });
    const component = await call("deploy", { ...deployArgs, component: "web" });
    expect(component.structuredContent).toMatchObject({
      code: "unknownComponent",
      params: { name: "web", valid: ["acme-api"] },
    });
    // A project the viewer cannot see is as unknown as a missing one.
    const project = await call("deploy", { ...deployArgs, projectKey: "BETA" });
    expect(project.structuredContent).toMatchObject({
      code: "unknownProject",
      params: { name: "BETA", valid: ["ACME"] },
    });
  });

  it("create_issue maps names to ids and passes the client as via", async () => {
    const result = await call("create_issue", {
      projectKey: "acme",
      title: "Login fails",
      type: "bug",
      priority: "high",
      assigneeEmail: "DEV@example.com",
      environmentSlug: "qa",
      labelNames: ["bug", "infra"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ key: "ACME-13" });
    expect(issueCores.createIssueFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      {
        projectId: ACME_ID,
        title: "Login fails",
        type: "bug",
        priority: "high",
        assigneeId: ASSIGNEE_ID,
        environmentId: ENV_ID,
        labelIds: [LABEL_BUG, LABEL_INFRA],
      },
      { client: "Acme Agent", clientId: CLIENT_ID }
    );
  });

  it("update_issue unassigns with assigneeEmail null", async () => {
    const result = await call("update_issue", {
      key: "ACME-12",
      assigneeEmail: null,
    });
    expect(result.isError).toBeFalsy();
    expect(issueCores.updateIssueFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      ISSUE_ID,
      { assigneeId: null },
      { client: "Acme Agent", clientId: CLIENT_ID }
    );
    expect(labelCores.setIssueLabelsFor).not.toHaveBeenCalled();

    await call("update_issue", { key: "ACME-12", labelNames: ["infra"] });
    expect(labelCores.setIssueLabelsFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      ISSUE_ID,
      [LABEL_INFRA],
      { client: "Acme Agent", clientId: CLIENT_ID }
    );
  });

  it("returns a core's refusal as a tool error", async () => {
    issueCores.updateIssueFor.mockResolvedValue({
      success: false,
      message: "Invalid issue data",
    });
    const result = await call("update_issue", { key: "ACME-12", title: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("invalidRequest: Invalid issue data");

    const { CodedHTTPException } = await import("@/server/errors");
    issueCores.addCommentFor.mockRejectedValue(
      new CodedHTTPException(409, "issueChanged", "Changed", { n: 1 })
    );
    const coded = await call("add_issue_comment", {
      key: "ACME-12",
      body: "Looks fixed",
    });
    expect(coded.structuredContent).toEqual({
      code: "issueChanged",
      params: { n: 1 },
    });

    issueCores.addCommentFor.mockRejectedValue(new Error("db down: secret"));
    const crash = await call("add_issue_comment", {
      key: "ACME-12",
      body: "Looks fixed",
    });
    expect(crash.isError).toBe(true);
    expect(textOf(crash)).toBe("add_issue_comment failed unexpectedly");
    expect(JSON.stringify(crash)).not.toContain("secret");
  });

  it("logs a failed query without its parameters (the tool input)", async () => {
    const { DrizzleQueryError } = await import("drizzle-orm/errors");
    const cause = Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    });
    issueCores.addCommentFor.mockRejectedValue(
      new DrizzleQueryError(
        "insert into issue_comments values ($1)",
        ["private note"],
        cause
      )
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await call("add_issue_comment", { key: "ACME-12", body: "private note" });
      const lines = logged.mock.calls.map((args) =>
        args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")
      );
      expect(lines.join("\n")).toContain("add_issue_comment");
      expect(lines.join("\n")).toContain("ECONNREFUSED");
      expect(lines.join("\n")).not.toContain("private note");
      for (const args of logged.mock.calls) {
        for (const arg of args) expect(arg).not.toBeInstanceOf(Error);
      }
    } finally {
      logged.mockRestore();
    }
  });

  it("refuses an over-long comment before the core", async () => {
    const result = await call("add_issue_comment", {
      key: "ACME-12",
      body: "x".repeat(20_001),
    });
    expect(result.isError).toBe(true);
    expect(issueCores.addCommentFor).not.toHaveBeenCalled();
  });

  it("unknown label name lists valid names", async () => {
    const result = await call("create_issue", {
      projectKey: "ACME",
      title: "Login fails",
      labelNames: ["bug", "nope"],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "unknownLabel",
      params: { name: "nope", valid: ["bug", "infra"] },
    });
    expect(textOf(result)).toContain("bug, infra");
    expect(issueCores.createIssueFor).not.toHaveBeenCalled();

    // At most 20 names.
    state.tables.set(
      schema.labels,
      Array.from({ length: 30 }, (_, i) => ({
        id: `label-${i}`,
        name: `label-${String(i).padStart(2, "0")}`,
      }))
    );
    const many = await call("create_issue", {
      projectKey: "ACME",
      title: "Login fails",
      labelNames: ["nope"],
    });
    const params = many.structuredContent?.params as { valid: string[] };
    expect(params.valid).toHaveLength(20);
  });

  it("annotates deploy and rollback destructive", async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t.annotations]));
      expect(byName.get("deploy")).toMatchObject({ destructiveHint: true });
      expect(byName.get("rollback")).toMatchObject({ destructiveHint: true });
      expect(byName.get("create_issue")).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(byName.get("update_issue")).toMatchObject({
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(byName.get("add_issue_comment")).toMatchObject({
        destructiveHint: false,
      });
    } finally {
      await client.close();
    }
  });
});
