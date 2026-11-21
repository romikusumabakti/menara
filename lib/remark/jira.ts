import { isNotNull } from "drizzle-orm";
import { issueComments, issues } from "@/lib/db/schema";
import { getBranding } from "@/lib/instance-branding";
import { attributionLine } from "@/lib/jira/attribution";
import { JiraClient, JiraError } from "@/lib/jira/client";
import { resolveLink } from "@/lib/jira/sync";
import type { AdfNode, JiraComment } from "@/lib/jira/types";
import { type Legacy, legacyPattern } from "@/lib/legacy";
import { menaraWords } from "@/lib/remark/instance-db";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";

// Step jira: a comment this instance pushed to Jira opens with an attribution
// paragraph (`*Written by <author> via <name>*`, lib/jira/attribution.ts).
// Where Jira's current body (read again: the stored copy has the attribution
// stripped, and a comment may have been edited since) names the previous
// product after "via", that first paragraph is rewritten to the instance name
// via updateComment; every other byte of the body stays as Jira returned it.
// Only comments the connection's own account wrote are touched (the only
// ones a push made, and the only ones it may edit). One item per comment.
//
// The instance name is the branding name; while that still carries the
// legacy name (the instance-db step converts it), its converted form is used,
// so the line never names the old product again.

const ATTRIBUTION_TEXT = /^Written by (.+) via ([^*\n]+)$/;
const WIKI_ATTRIBUTION = /^\*(Written by .+ via [^*\n]+)\*(?=\n|$)/;
const TARGET =
  /^jira\/projects\/([0-9a-f-]{36})\/issues\/([^/]+)\/comments\/([^/]+)$/i;

const target = (projectId: string, issueId: string, commentId: string) =>
  `jira/projects/${projectId}/issues/${issueId}/comments/${commentId}`;

async function instanceName(l: Legacy): Promise<string> {
  return menaraWords((await getBranding()).name, l);
}

/** The attribution text (`Written by A via N`) with the instance name, or null when it names no legacy product. */
function converted(
  text: string,
  l: Legacy,
  name: string
): { from: string; to: string } | null {
  const m = ATTRIBUTION_TEXT.exec(text);
  if (!m?.[1] || !m[2] || !legacyPattern(l).test(m[2])) return null;
  // attributionLine is `*<text>*\n\n`; the item carries the text alone.
  const to = attributionLine(m[1], name).trim().slice(1, -1);
  return { from: text, to };
}

/**
 * The body with its legacy attribution rewritten, and the old and new
 * attribution text; null when the body does not open with one. ADF: only the
 * first paragraph's text changes (its marks and attrs are kept); wiki
 * markup: only the first line.
 */
export function rewriteAttribution(
  body: unknown,
  l: Legacy,
  name: string
): { from: string; to: string; body: unknown } | null {
  if (typeof body === "string") {
    const m = WIKI_ATTRIBUTION.exec(body);
    const change = m?.[1] ? converted(m[1], l, name) : null;
    if (!m || !change) return null;
    return {
      ...change,
      body: `*${change.to}*${body.slice(m[0].length)}`,
    };
  }
  const doc = body as AdfNode | null;
  const first = doc?.type === "doc" ? doc.content?.[0] : undefined;
  const parts = first?.type === "paragraph" ? first.content : undefined;
  if (!doc || !first || !parts?.length) return null;
  if (!parts.every((p) => p.type === "text")) return null;
  const change = converted(parts.map((p) => p.text ?? "").join(""), l, name);
  if (!change) return null;
  const [lead] = parts as [AdfNode];
  return {
    ...change,
    body: {
      ...doc,
      content: [
        { ...first, content: [{ ...lead, text: change.to }] },
        ...(doc.content ?? []).slice(1),
      ],
    },
  };
}

type Account = { accountId?: string; name?: string };

function writtenBy(comment: JiraComment, me: Account): boolean {
  const author = comment.author as Account | null | undefined;
  if (!author) return false;
  if (me.accountId) return author.accountId === me.accountId;
  return Boolean(me.name) && author.name === me.name;
}

/** The comment as Jira holds it now; null when it was deleted there. */
async function remoteComment(
  client: JiraClient,
  issueId: string,
  commentId: string
): Promise<JiraComment | null> {
  try {
    return await client.getComment(issueId, commentId);
  } catch (error) {
    if (error instanceof JiraError && error.status === 404) return null;
    throw error;
  }
}

/** The items of one remote issue's pushed comments. */
async function issueItems(
  client: JiraClient,
  me: Account,
  l: Legacy,
  name: string,
  projectId: string,
  { issueId, ids }: { issueId: string; ids: string[] }
): Promise<RemarkItem[]> {
  // One read covers the issue's latest comments; older ones are read alone.
  const page = new Map(
    (await client.getComments(issueId)).comments.map((c) => [c.id, c])
  );
  const items: RemarkItem[] = [];
  for (const id of ids) {
    const comment = page.get(id) ?? (await remoteComment(client, issueId, id));
    if (!comment || !writtenBy(comment, me)) continue;
    const change = rewriteAttribution(comment.body, l, name);
    if (!change) continue;
    items.push({
      step: "jira",
      target: target(projectId, issueId, id),
      from: change.from,
      to: change.to,
    });
  }
  return items;
}

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const name = await instanceName(ctx.legacy);
  const [comments, issueRows] = await Promise.all([
    ctx.db
      .select({
        issueId: issueComments.issueId,
        jiraCommentId: issueComments.jiraCommentId,
      })
      .from(issueComments)
      .where(isNotNull(issueComments.jiraCommentId)),
    ctx.db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        jiraIssueId: issues.jiraIssueId,
      })
      .from(issues),
  ]);
  const issueById = new Map(issueRows.map((i) => [i.id, i]));
  // project → remote issue → remote comment ids, in row order.
  const byProject = new Map<string, Map<string, string[]>>();
  for (const c of comments) {
    const issue = issueById.get(c.issueId);
    if (!issue?.jiraIssueId || !c.jiraCommentId) continue;
    const perIssue = byProject.get(issue.projectId) ?? new Map();
    perIssue.set(issue.jiraIssueId, [
      ...(perIssue.get(issue.jiraIssueId) ?? []),
      c.jiraCommentId,
    ]);
    byProject.set(issue.projectId, perIssue);
  }

  const items: RemarkItem[] = [];
  for (const [projectId, perIssue] of byProject) {
    const where = `jira/projects/${projectId}`;
    try {
      const resolved = await resolveLink(projectId);
      // No Jira link any more: nothing this instance can reach.
      if (!resolved) continue;
      const client = new JiraClient(resolved.credentials);
      const me = (await client.getMyself()) as Account;
      for (const [issueId, ids] of perIssue) {
        try {
          items.push(
            ...(await issueItems(client, me, ctx.legacy, name, projectId, {
              issueId,
              ids,
            }))
          );
        } catch (error) {
          // A deleted issue has no comments left to convert.
          if (error instanceof JiraError && error.status === 404) continue;
          ctx.log.error(`${where}/issues/${issueId}`, messageOf(error));
        }
      }
    } catch (error) {
      ctx.log.error(where, messageOf(error));
    }
  }
  return items;
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const m = TARGET.exec(item.target);
  if (!m) throw new Error(`no such target: ${item.target}`);
  const [, projectId, issueId, commentId] = m as unknown as [
    string,
    string,
    string,
    string,
  ];
  const resolved = await resolveLink(projectId);
  if (!resolved) throw new Error("the project has no Jira link any more");
  const client = new JiraClient(resolved.credentials);
  const comment = await remoteComment(client, issueId, commentId);
  if (!comment) throw new Error("the comment was deleted in Jira");
  if (!writtenBy(comment, (await client.getMyself()) as Account)) {
    throw new Error("the comment is not the connection account's");
  }
  const name = await instanceName(ctx.legacy);
  const change = rewriteAttribution(comment.body, ctx.legacy, name);
  if (!change) {
    // Converted by an earlier run, or edited since the plan: never guess.
    return;
  }
  if (change.from !== item.from || change.to !== item.to) {
    throw new Error("the comment's attribution changed since it was planned");
  }
  await client.updateComment(issueId, commentId, change.body);
}
