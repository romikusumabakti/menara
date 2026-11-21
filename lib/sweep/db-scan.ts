import { ilike } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { db as Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { type Legacy, legacyPattern } from "@/lib/legacy";
import { isEncrypted } from "@/lib/secrets";
import { EXCERPT_MAX, type SweepHit } from "@/lib/sweep/types";

// Broad read-only scan of Menara's own database: every text column of every
// table, so a trace in a place `remark` does not know is found. History is
// left as written (spec G4), so the log tables below are skipped, and so is
// anything that may hold a secret.

/** Tables that record what happened (logs, job and chat history). */
export const HISTORICAL_TABLES: ReadonlySet<string> = new Set([
  "activity_log",
  "runs",
  "provisioning_steps",
  "teardown_steps",
  "builds",
  "deployments",
  "ssh_key_jobs",
  "instance_backups",
  "notifications",
  "releases",
  "assistant_conversations",
  "assistant_messages",
  "assistant_tool_calls",
  "assistant_usage",
]);

/** Columns holding credentials or key material, by name. */
const SECRET_COLUMN =
  /password|secret|token|private_key|api_key|hash|signature/i;

/** Tables that only hold credentials, sessions and verification codes. */
export const SECRET_TABLES: ReadonlySet<string> = new Set([
  "sessions",
  "two_factors",
  "passkeys",
  "verifications",
]);

/** Columns that may hold a secret in plain text (kind "secret" variables). */
export const SECRET_COLUMNS: ReadonlySet<string> = new Set([
  "environment_variables.value",
]);

const ROW_LIMIT = 1000;

export type ScanTarget = {
  table: string;
  column: string;
  /** Row id, as the report prints it. */
  idColumns: string[];
};

export type ScanRow = { id: string; value: string };

export type ScanColumn = (target: ScanTarget) => Promise<ScanRow[]>;

/** Every text column to scan: historical tables and secret columns left out. */
export function scanTargets(): (ScanTarget & { source: unknown })[] {
  const targets: (ScanTarget & { source: unknown })[] = [];
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null) continue;
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue;
    }
    if (
      !config.name ||
      HISTORICAL_TABLES.has(config.name) ||
      SECRET_TABLES.has(config.name)
    ) {
      continue;
    }
    const pk = config.columns.filter((c) => c.primary);
    const idColumns = (
      pk.length ? pk : (config.primaryKeys[0]?.columns ?? [])
    ).map((c) => c.name);
    for (const column of config.columns) {
      if (
        column.columnType !== "PgText" ||
        SECRET_COLUMN.test(column.name) ||
        SECRET_COLUMNS.has(`${config.name}.${column.name}`)
      ) {
        continue;
      }
      targets.push({
        table: config.name,
        column: column.name,
        idColumns,
        source: { table: value, column },
      });
    }
  }
  return targets;
}

/** The default reader: rows of one column that mention the name at all. */
export function drizzleScanColumn(db: typeof Db, l: Legacy): ScanColumn {
  const sources = new Map(
    scanTargets().map((t) => [`${t.table}.${t.column}`, t.source])
  );
  return async (target) => {
    const { table, column } = sources.get(
      `${target.table}.${target.column}`
    ) as { table: PgTable; column: Parameters<typeof ilike>[0] };
    const cols = getTableConfig(table).columns;
    const fields: Record<string, (typeof cols)[number]> = {
      value: column as never,
    };
    for (const name of target.idColumns) {
      const c = cols.find((x) => x.name === name);
      if (c) fields[`id:${name}`] = c;
    }
    const rows = (await db
      .select(fields as never)
      .from(table)
      .where(ilike(column, `%${l.name.replace(/[\\%_]/g, "\\$&")}%`))
      .limit(ROW_LIMIT)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: target.idColumns.map((n) => String(row[`id:${n}`])).join(",") || "-",
      value: String(row.value ?? ""),
    }));
  };
}

function excerpt(text: string, l: Legacy): string {
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= EXCERPT_MAX) return flat;
  const at = legacyPattern(l).exec(flat)?.index ?? 0;
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, start + EXCERPT_MAX);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * One hit per row whose text names the previous product as a word. The SQL
 * filter is a coarse substring match; the whole-word check is here.
 */
export async function scanDatabase(
  db: typeof Db,
  l: Legacy,
  scanColumn: ScanColumn = drizzleScanColumn(db, l)
): Promise<SweepHit[]> {
  const pattern = legacyPattern(l);
  const hits: SweepHit[] = [];
  for (const target of scanTargets()) {
    const rows = await scanColumn(target);
    for (const row of rows) {
      if (isEncrypted(row.value) || !pattern.test(row.value)) continue;
      hits.push({
        system: "database",
        location: `${target.table}.${target.column} (${row.id})`,
        excerpt: excerpt(row.value, l),
      });
    }
  }
  return hits;
}
