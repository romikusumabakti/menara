import { asc, eq } from "drizzle-orm";
import {
  type AccessScope,
  accessScopeFromSession,
  requireProjectPermissionIn,
} from "@/lib/access-scope";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { issueLabels, type Label, labels } from "@/lib/db/schema";

/** All workspace labels, name-ordered — for chips and the label filter/picker. */
export async function listLabels(): Promise<Label[]> {
  await requireSession();
  try {
    return await db.select().from(labels).orderBy(asc(labels.name));
  } catch (error) {
    console.error("Failed to list labels:", error);
    return [];
  }
}

/** Replace an issue's label set with `labelIds` (transactional). */
export async function setIssueLabels(
  issueId: string,
  labelIds: string[]
): Promise<{ success: boolean }> {
  return setIssueLabelsFor(await accessScopeFromSession(), issueId, labelIds);
}

/** setIssueLabels for a scope (the session's, or an MCP token's). */
export async function setIssueLabelsFor(
  scope: AccessScope,
  issueId: string,
  labelIds: string[]
): Promise<{ success: boolean }> {
  await requireProjectPermissionIn(scope, { issueId }, { issue: ["write"] });
  try {
    await db.transaction(async (tx) => {
      await tx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
      if (labelIds.length > 0) {
        await tx
          .insert(issueLabels)
          .values(labelIds.map((labelId) => ({ issueId, labelId })));
      }
    });
    return { success: true };
  } catch (error) {
    console.error("Failed to set issue labels:", error);
    return { success: false };
  }
}
