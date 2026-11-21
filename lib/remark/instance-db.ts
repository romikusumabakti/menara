import { eq } from "drizzle-orm";
import { instanceSettings } from "@/lib/db/schema";
import { invalidateBranding } from "@/lib/instance-branding";
import { type Legacy, legacyPattern } from "@/lib/legacy";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";

// Step instance-db: settings in Menara's own database that name the previous
// product, as a word, get the Menara name (case kept: oldtool → menara,
// Oldtool → Menara, OLDTOOL → MENARA). The columns are an explicit
// allow-list of text the product shows or uses as its own name, never a scan:
//
// - instance_settings.brand_name: the instance name in the UI, mails and the
//   Jira attribution (an install that named itself after the product);
// - instance_settings.assistant_org_context: the admin's standing
//   instructions to the Assistant, which would keep it calling the product
//   by its old name.
//
// Left out on purpose: history (activity log, runs, deploy and job steps,
// notifications, Assistant conversations, releases) stays as it was written
// (spec G4); user content (issues, comments, knowledge, saved views,
// labels); values that address something outside the database, where a
// rename breaks the link (S3 key prefixes, Jira JQL filters, connection,
// server and tunnel names mirroring external resources, app/service variable
// templates and environment variables an app reads, stored build specs that
// hold repository paths, images and `build_` secret names); the company name
// (an organisation, not the product); and the columns other steps convert
// (notify_secret_name: woodpecker, assistant_db_login: assistant-logins,
// backup and archive keys: s3).

const SETTINGS_ID = 1;

type Column = "brandName" | "assistantOrgContext";

const COLUMNS: { column: Column; target: string }[] = [
  { column: "brandName", target: "instance_settings/brand_name" },
  {
    column: "assistantOrgContext",
    target: "instance_settings/assistant_org_context",
  },
];

/** `text` with every legacy word replaced by the Menara name, its case kept. */
export function menaraWords(text: string, l: Legacy): string {
  const all = new RegExp(legacyPattern(l).source, "gi");
  return text.replace(all, (word) =>
    word === word.toLowerCase()
      ? "menara"
      : word === word.toUpperCase()
        ? "MENARA"
        : "Menara"
  );
}

const EXCERPT_MAX = 120;
const EXCERPT_CONTEXT = 40;

/**
 * The old and new text as the report shows them: whole when short, else the
 * first trace with some context. Whitespace runs read as one space.
 */
function excerpts(
  text: string,
  l: Legacy
): { from: string; to: string } | null {
  const to = menaraWords(text, l);
  if (to === text) return null;
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const [a, b] = [flat(text), flat(to)];
  if (a.length <= EXCERPT_MAX) return { from: a, to: b };
  const match = legacyPattern(l).exec(a);
  const at = match?.index ?? 0;
  const length = match?.[0].length ?? 0;
  const start = Math.max(0, at - EXCERPT_CONTEXT);
  const cut = (s: string, wordLength: number) => {
    const end = at + wordLength + EXCERPT_CONTEXT;
    return `${start > 0 ? "…" : ""}${s.slice(start, end)}${end < s.length ? "…" : ""}`;
  };
  const replaced = menaraWords(match?.[0] ?? "", l).length;
  return { from: cut(a, length), to: cut(b, replaced) };
}

async function settingsRow(ctx: RemarkContext) {
  const [row] = await ctx.db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  return row ?? null;
}

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const row = await settingsRow(ctx);
  if (!row) return [];
  const items: RemarkItem[] = [];
  for (const { column, target } of COLUMNS) {
    const value = row[column];
    const change =
      typeof value === "string" ? excerpts(value, ctx.legacy) : null;
    if (change) items.push({ step: "instance-db", target, ...change });
  }
  return items;
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const entry = COLUMNS.find((c) => c.target === item.target);
  if (!entry) throw new Error(`no such target: ${item.target}`);
  const row = await settingsRow(ctx);
  const value = row?.[entry.column];
  if (typeof value !== "string") return;
  const change = excerpts(value, ctx.legacy);
  // Converted by an earlier run.
  if (!change) return;
  if (change.from !== item.from || change.to !== item.to) {
    throw new Error("the value changed since it was planned; run remark again");
  }
  await ctx.db
    .update(instanceSettings)
    .set(
      entry.column === "brandName"
        ? {
            brandName: menaraWords(value, ctx.legacy),
            brandUpdatedAt: new Date(),
          }
        : { [entry.column]: menaraWords(value, ctx.legacy) }
    )
    .where(eq(instanceSettings.id, SETTINGS_ID));
  if (entry.column === "brandName") invalidateBranding();
}
