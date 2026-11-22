// Finished Assistant conversations, written the way a done turn is stored:
// a user message carrying its context and an assistant message whose answer
// renders from `content` (no stream parts, no tool calls, no cost rows).
import { and, eq } from "drizzle-orm";
import { assistantConversations, assistantMessages } from "@/lib/db/schema";
import { DEMO_CONVERSATIONS } from "../seed-data/assistant";
import { addMinutes, addSeconds, workTime } from "../seed-data/random";
import { count, personId, type SeedContext } from "./context";

export async function seedAssistant(ctx: SeedContext): Promise<void> {
  const { tx, now } = ctx;
  for (const [index, convo] of DEMO_CONVERSATIONS.entries()) {
    const userId = personId(ctx, convo.owner);
    if (!userId) continue;
    const project = convo.project ? ctx.projects.get(convo.project) : undefined;
    // A pinned conversation needs its demo project; skip it if that is gone.
    if (convo.project && !project) continue;
    const [existing] = await tx
      .select({ id: assistantConversations.id })
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.userId, userId),
          eq(assistantConversations.title, convo.title)
        )
      );
    if (existing) continue;

    let at = workTime(now, convo.daysAgo, 120 + index * 7);
    const createdAt = at;
    const [row] = await tx
      .insert(assistantConversations)
      .values({
        userId,
        title: convo.title,
        titleSource: "generated",
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: assistantConversations.id });
    if (!row) continue;
    count(ctx, "assistantConversations");

    for (const turn of convo.turns) {
      const context = project
        ? { projectId: project.id, projectName: project.name }
        : {};
      await tx.insert(assistantMessages).values({
        conversationId: row.id,
        role: "user",
        content: turn.question,
        status: "done",
        ...context,
        createdAt: at,
        finishedAt: at,
      });
      const answeredAt = addSeconds(at, 1);
      await tx.insert(assistantMessages).values({
        conversationId: row.id,
        role: "assistant",
        content: turn.answer,
        status: "done",
        createdAt: answeredAt,
        finishedAt: addSeconds(answeredAt, 18),
      });
      count(ctx, "assistantMessages", 2);
      at = addMinutes(at, 2);
    }
    await tx
      .update(assistantConversations)
      .set({ updatedAt: at })
      .where(eq(assistantConversations.id, row.id));
  }
}
