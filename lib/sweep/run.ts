import type { db as Db } from "@/lib/db";
import type { Legacy } from "@/lib/legacy";
import { REMARK_MODULES } from "@/lib/remark/run";
import {
  messageOf,
  REMARK_STEPS,
  type RemarkContext,
} from "@/lib/remark/types";
import { finish } from "@/lib/remark/woodpecker";
import { type ScanColumn, scanDatabase } from "@/lib/sweep/db-scan";
import { type SweepHit, type SweepReport, shorten } from "@/lib/sweep/types";

// `menara sweep`: the read-only counterpart of `remark`. It reuses each
// remark step's plan (the same lookups, never apply) plus the legacy notify
// secrets `remark --finish` would still delete, plus a scan of the database
// for anything in an unexpected place. A system that cannot be read is
// reported as a hit, so a sweep is clean only when everything was checked.

const unchecked = (system: string, location: string, message: string) => ({
  system,
  location,
  excerpt: shorten(`could not check: ${message}`),
});

export async function runSweep(
  base: {
    legacy: Legacy;
    db: typeof Db;
    log?: { info(message: string): void };
  },
  deps: { scanColumn?: ScanColumn } = {}
): Promise<SweepReport> {
  const hits: SweepHit[] = [];
  for (const step of REMARK_STEPS) {
    const ctx: RemarkContext = {
      legacy: base.legacy,
      db: base.db,
      log: {
        info: (message) => base.log?.info(`[${step}] ${message}`),
        error: (target, message) => hits.push(unchecked(step, target, message)),
      },
    };
    try {
      for (const item of await REMARK_MODULES[step].plan(ctx)) {
        hits.push({
          system: step,
          location: item.target,
          excerpt: shorten(item.from),
        });
      }
    } catch (error) {
      hits.push(unchecked(step, step, messageOf(error)));
    }
  }

  const system = "woodpecker-secrets";
  try {
    const report = await finish(
      { legacy: base.legacy, db: base.db },
      { apply: false }
    );
    for (const e of report.entries) {
      hits.push({
        system,
        location: e.target,
        excerpt: shorten(`${e.repo}: ${e.secret}`),
      });
    }
    for (const e of report.errors) {
      hits.push(unchecked(system, e.target, e.message));
    }
  } catch (error) {
    hits.push(unchecked(system, system, messageOf(error)));
  }

  try {
    hits.push(...(await scanDatabase(base.db, base.legacy, deps.scanColumn)));
  } catch (error) {
    hits.push(unchecked("database", "database", messageOf(error)));
  }
  return { hits, failed: hits.length > 0 };
}

export function formatSweepReport(report: SweepReport): string[] {
  if (report.hits.length === 0) {
    return ["menara sweep: no trace of the previous name found."];
  }
  return [
    `menara sweep: ${report.hits.length} trace(s) left`,
    ...report.hits.map((h) => `${h.system}: ${h.location}: ${h.excerpt}`),
  ];
}
