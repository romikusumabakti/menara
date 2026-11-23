import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { WriteVia } from "@/lib/activity";
import { assignableUsersWhere } from "@/lib/assignees";
import { loadProjectEntries, visibleProjects } from "@/lib/assistant/viewer";
import { db } from "@/lib/db";
import {
  deployTargets,
  environments,
  issues,
  labels,
  projectMembers,
  users,
} from "@/lib/db/schema";
import { resolveEnvironmentBySlug } from "@/lib/environment-slug";
import {
  issuePrioritySchema,
  issueStatusSchema,
  issueTypeSchema,
} from "@/lib/validation";
import { CodedHTTPException, errorCode } from "@/server/errors";
import { deployTagFor, rollbackTargetFor } from "@/server/services/deploys";
import {
  addCommentFor,
  createIssueFor,
  updateIssueFor,
} from "@/server/services/issues";
import { setIssueLabelsFor } from "@/server/services/labels";
import { assertAgentWritableEnvironment } from "./environment-rule";
import type { McpCaller } from "./gate";
import { logCall } from "./read-tools";
import type { McpScope } from "./scopes";

// Menara's write tools over MCP. Each one resolves the names an agent knows
// (project key, issue key, environment slug, component, label, email) inside
// the viewer's scope, then calls the same scope-taking core the UI's routes
// call, so permissions, validation and the activity row are the UI's; the
// row also names the MCP client (`via`). Deploy and rollback first pass the
// agent environment rule (lib/mcp/environment-rule).

/** The write tools and the scope each needs (the route counts them as writes). */
export const WRITE_TOOL_SCOPES = {
  create_issue: "issues:write",
  update_issue: "issues:write",
  add_issue_comment: "issues:write",
  deploy: "deploys:write",
  rollback: "deploys:write",
} as const satisfies Record<string, McpScope>;

type WriteToolName = keyof typeof WRITE_TOOL_SCOPES;

/** Whether `name` is one of the write tools. */
export function isWriteTool(name: string): name is WriteToolName {
  return Object.hasOwn(WRITE_TOOL_SCOPES, name);
}

/** How many valid names an "unknown name" error lists. */
const MAX_VALID_NAMES = 20;

/** A refusal the tool answers itself, as `"<code>: <message>"`. */
class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ToolRefusal";
  }
}

function unknownName(
  code: string,
  what: string,
  name: string,
  valid: string[]
): ToolRefusal {
  const listed = valid.slice(0, MAX_VALID_NAMES);
  const more = valid.length > listed.length ? ", …" : "";
  return new ToolRefusal(
    code,
    listed.length > 0
      ? `No ${what} "${name}". Valid: ${listed.join(", ")}${more}`
      : `No ${what} "${name}", and none to choose from.`,
    { name, valid: listed }
  );
}

// A refusal thrown by a core without a code still gets a stable one: its
// status, by name. The message stays the core's, as the UI shows it.
const STATUS_CODES: Record<number, string> = {
  400: "badRequest",
  401: "unauthorized",
  403: "forbidden",
  404: "notFound",
  409: "conflict",
  413: "tooLarge",
  422: "invalidRequest",
  423: "locked",
  429: "rateLimited",
  503: "unavailable",
};

function toolError(
  code: string,
  message: string,
  params: Record<string, unknown> = {}
): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { code, params },
  };
}

function toolOk(data: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

/** A core's ActionResponse failure: its code, or a generic one. */
function refuseAction(response: { message: string; code?: string }): never {
  throw new ToolRefusal(response.code ?? "invalidRequest", response.message);
}

/** Maps what a tool body threw to its MCP result; anything unknown is logged. */
function errorResult(tool: string, error: unknown): CallToolResult {
  if (error instanceof ToolRefusal) {
    return toolError(error.code, error.message, error.params);
  }
  if (error instanceof HTTPException) {
    const code =
      errorCode(error) ?? STATUS_CODES[error.status] ?? `http${error.status}`;
    const params =
      error instanceof CodedHTTPException ? (error.params ?? {}) : {};
    return toolError(code, error.message || code, params);
  }
  console.error(`[mcp] tool ${tool} failed`, error);
  return {
    isError: true,
    content: [{ type: "text", text: `${tool} failed unexpectedly` }],
  };
}

// --- Name resolution, inside the viewer's scope -----------------------------

type Project = { id: string; key: string };

/** A project the viewer sees, by key (any case). */
async function resolveProject(
  caller: McpCaller,
  projectKey: string
): Promise<Project> {
  const visible = visibleProjects(caller.viewer, await loadProjectEntries());
  const key = projectKey.trim().toUpperCase();
  const project = visible.find((p) => p.key.toUpperCase() === key);
  if (!project) {
    throw unknownName(
      "unknownProject",
      "project",
      projectKey,
      visible.map((p) => p.key)
    );
  }
  return project;
}

/**
 * An environment of the project, by slug: its current one, or one it had
 * before a rename (as a `/KEY/slug` link resolves).
 */
async function resolveEnvironment(
  project: Project,
  slug: string
): Promise<{ id: string }> {
  const resolved = await resolveEnvironmentBySlug(project.id, slug.trim());
  // An alias keeps naming an environment that moved to another project,
  // which the viewer may not see: only this project's count.
  if (resolved && resolved.environment.projectId === project.id) {
    return resolved.environment;
  }
  const rows = await db
    .select({ slug: environments.slug })
    .from(environments)
    .where(eq(environments.projectId, project.id))
    .orderBy(asc(environments.slug));
  throw unknownName(
    "unknownEnvironment",
    `environment in ${project.key}`,
    slug,
    rows.map((row) => row.slug)
  );
}

/** The deploy target of `component` in the environment. */
async function resolveTarget(
  environmentId: string,
  environmentSlug: string,
  component: string
): Promise<{ id: string }> {
  const rows = await db
    .select({ id: deployTargets.id, componentKey: deployTargets.componentKey })
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(asc(deployTargets.componentKey));
  const target = rows.find((row) => row.componentKey === component.trim());
  if (!target) {
    throw unknownName(
      "unknownComponent",
      `component deployed to ${environmentSlug}`,
      component,
      rows.map((row) => row.componentKey)
    );
  }
  return target;
}

const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-([1-9][0-9]{0,8})$/;

/** An issue the viewer sees, by key ("ACME-12"). */
async function resolveIssue(
  caller: McpCaller,
  key: string
): Promise<{ id: string; projectId: string; key: string }> {
  const match = ISSUE_KEY.exec(key.trim().toUpperCase());
  if (!match?.[1] || !match[2]) {
    throw new ToolRefusal(
      "invalidIssueKey",
      `"${key}" is not an issue key like ACME-12.`,
      { key }
    );
  }
  const notFound = new ToolRefusal("issueNotFound", `Issue ${key} not found.`, {
    key,
  });
  const visible = visibleProjects(caller.viewer, await loadProjectEntries());
  const project = visible.find((p) => p.key.toUpperCase() === match[1]);
  if (!project) throw notFound;
  const [issue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, Number(match[2])))
    )
    .limit(1);
  if (!issue) throw notFound;
  return {
    id: issue.id,
    projectId: project.id,
    key: `${project.key}-${match[2]}`,
  };
}

/** A user the issue may be assigned to in the project, by email (any case). */
async function resolveAssignee(
  projectId: string,
  email: string
): Promise<string> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(assignableUsersWhere(eq(projectMembers.projectId, projectId)))
    .orderBy(asc(sql`lower(${users.email})`));
  const wanted = email.trim().toLowerCase();
  const user = rows.find((row) => row.email.toLowerCase() === wanted);
  if (!user) {
    throw unknownName(
      "unknownAssignee",
      "assignable user with the email",
      email,
      rows.map((row) => row.email)
    );
  }
  return user.id;
}

/** Workspace labels by name (any case), in the given order, once each. */
async function resolveLabels(names: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .orderBy(asc(labels.name));
  const ids: string[] = [];
  for (const name of names) {
    const wanted = name.trim().toLowerCase();
    const label = rows.find((row) => row.name.toLowerCase() === wanted);
    if (!label) {
      throw unknownName(
        "unknownLabel",
        "label",
        name,
        rows.map((row) => row.name)
      );
    }
    if (!ids.includes(label.id)) ids.push(label.id);
  }
  return ids;
}

// --- Inputs -----------------------------------------------------------------

const projectKey = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe("Project key, e.g. ACME");
const issueKey = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe("Issue key, e.g. ACME-12");
const environmentSlug = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe("Environment slug within the project, e.g. qa");
const labelNames = z
  .array(z.string().trim().min(1).max(100))
  .max(100)
  .describe("Workspace label names");

const createIssueInput = z.object({
  projectKey,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  type: issueTypeSchema.optional(),
  priority: issuePrioritySchema.optional(),
  assigneeEmail: z.string().trim().min(1).max(320).optional(),
  environmentSlug: environmentSlug.optional(),
  labelNames: labelNames.optional(),
});

const updateIssueInput = z.object({
  key: issueKey,
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  status: issueStatusSchema.optional(),
  priority: issuePrioritySchema.optional(),
  assigneeEmail: z
    .string()
    .trim()
    .min(1)
    .max(320)
    .nullable()
    .optional()
    .describe("The assignee's email; null unassigns"),
  labelNames: labelNames
    .optional()
    .describe("Replaces the issue's labels; [] removes them all"),
});

const addCommentInput = z.object({
  key: issueKey,
  body: z.string().min(1).max(20_000).describe("Markdown, 1–20,000 characters"),
});

const deployInput = z.object({
  projectKey,
  environmentSlug,
  component: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("Component key of the deploy target"),
  tag: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("A CI build tag of the target's branch"),
});

const rollbackInput = deployInput.omit({ tag: true });

// --- Tools ------------------------------------------------------------------

/** The issue as a write tool returns it. */
function issueSummary(
  key: string,
  issue: { title: string; status: string; type: string; priority: string }
) {
  return {
    key,
    title: issue.title,
    status: issue.status,
    type: issue.type,
    priority: issue.priority,
  };
}

/** Registers the write tools the caller's scopes allow on `server`. */
export function registerWriteTools(server: McpServer, caller: McpCaller): void {
  const scope = caller.viewer.scope;
  const via: WriteVia = {
    client: caller.clientName,
    clientId: caller.clientId,
  };
  const allowed = (name: WriteToolName) =>
    caller.scopes.has(WRITE_TOOL_SCOPES[name]);

  /** Runs a tool body with the per-call log line and the error mapping. */
  const run =
    <I>(name: WriteToolName, body: (input: I) => Promise<CallToolResult>) =>
    async (input: I): Promise<CallToolResult> => {
      const startedAt = performance.now();
      let result: CallToolResult;
      try {
        result = await body(input);
      } catch (error) {
        result = errorResult(name, error);
      }
      logCall(name, caller, startedAt, result.isError ? "error" : "ok");
      return result;
    };

  if (allowed("create_issue")) {
    server.registerTool(
      "create_issue",
      {
        title: "Create issue",
        description:
          "Create an issue in a project. Names (assignee email, environment slug, label names) are resolved in the project; an unknown one is refused with the valid names.",
        inputSchema: createIssueInput,
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      run("create_issue", async (input: z.infer<typeof createIssueInput>) => {
        const project = await resolveProject(caller, input.projectKey);
        const data = {
          projectId: project.id,
          title: input.title,
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.type && { type: input.type }),
          ...(input.priority && { priority: input.priority }),
          ...(input.assigneeEmail && {
            assigneeId: await resolveAssignee(project.id, input.assigneeEmail),
          }),
          ...(input.environmentSlug && {
            environmentId: (
              await resolveEnvironment(project, input.environmentSlug)
            ).id,
          }),
          ...(input.labelNames && {
            labelIds: await resolveLabels(input.labelNames),
          }),
        };
        const response = await createIssueFor(scope, data, via);
        if (!response.success) refuseAction(response);
        return toolOk(
          issueSummary(`${project.key}-${response.data.number}`, response.data)
        );
      })
    );
  }

  if (allowed("update_issue")) {
    server.registerTool(
      "update_issue",
      {
        title: "Update issue",
        description:
          "Change an issue's title, description, status, priority, assignee or labels. Only the fields given change; assigneeEmail null unassigns, labelNames replaces the label set.",
        inputSchema: updateIssueInput,
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      run("update_issue", async (input: z.infer<typeof updateIssueInput>) => {
        const issue = await resolveIssue(caller, input.key);
        const changes = {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.status && { status: input.status }),
          ...(input.priority && { priority: input.priority }),
          ...(input.assigneeEmail !== undefined && {
            assigneeId:
              input.assigneeEmail === null
                ? null
                : await resolveAssignee(issue.projectId, input.assigneeEmail),
          }),
        };
        const labelIds =
          input.labelNames && (await resolveLabels(input.labelNames));
        if (Object.keys(changes).length === 0 && !labelIds) {
          throw new ToolRefusal(
            "nothingToUpdate",
            "Give at least one field to change."
          );
        }
        let summary: Record<string, unknown> = { key: issue.key };
        if (Object.keys(changes).length > 0) {
          const response = await updateIssueFor(scope, issue.id, changes, via);
          if (!response.success) refuseAction(response);
          summary = issueSummary(issue.key, response.data);
        }
        if (labelIds) {
          const labelled = await setIssueLabelsFor(
            scope,
            issue.id,
            labelIds,
            via
          );
          if (!labelled.success) {
            throw new ToolRefusal(
              "labelsNotSaved",
              "Failed to set the labels."
            );
          }
          summary.labelNames = input.labelNames;
        }
        return toolOk(summary);
      })
    );
  }

  if (allowed("add_issue_comment")) {
    server.registerTool(
      "add_issue_comment",
      {
        title: "Comment on issue",
        description: "Add a comment (Markdown) to an issue.",
        inputSchema: addCommentInput,
        annotations: { destructiveHint: false },
      },
      run(
        "add_issue_comment",
        async (input: z.infer<typeof addCommentInput>) => {
          const issue = await resolveIssue(caller, input.key);
          const response = await addCommentFor(
            scope,
            issue.id,
            input.body,
            via
          );
          if (!response.success) {
            refuseAction({ message: response.message ?? "Comment not added" });
          }
          return toolOk({ key: issue.key, commented: true });
        }
      )
    );
  }

  /** The target of a deploy or rollback, after the agent environment rule. */
  const writableTarget = async (input: z.infer<typeof rollbackInput>) => {
    const project = await resolveProject(caller, input.projectKey);
    const environment = await resolveEnvironment(
      project,
      input.environmentSlug
    );
    await assertAgentWritableEnvironment(environment.id);
    return resolveTarget(
      environment.id,
      input.environmentSlug,
      input.component
    );
  };

  if (allowed("deploy")) {
    server.registerTool(
      "deploy",
      {
        title: "Deploy build",
        description:
          "Deploy a CI build tag of the target's branch to a component of a dev, qa or sandbox environment. Other environments are refused (mcpEnvironmentReadOnly); use the web UI for them.",
        inputSchema: deployInput,
        annotations: { destructiveHint: true },
      },
      run("deploy", async (input: z.infer<typeof deployInput>) => {
        const target = await writableTarget(input);
        const queued = await deployTagFor(scope, target.id, input.tag, via);
        return toolOk({ ...queued, tag: input.tag });
      })
    );
  }

  if (allowed("rollback")) {
    server.registerTool(
      "rollback",
      {
        title: "Roll back",
        description:
          "Deploy the component's previous successful tag again, on a dev, qa or sandbox environment. Other environments are refused (mcpEnvironmentReadOnly).",
        inputSchema: rollbackInput,
        annotations: { destructiveHint: true },
      },
      run("rollback", async (input: z.infer<typeof rollbackInput>) => {
        const target = await writableTarget(input);
        return toolOk(await rollbackTargetFor(scope, target.id, via));
      })
    );
  }
}
