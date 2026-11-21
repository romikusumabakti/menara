import * as assistantLogins from "@/lib/remark/assistant-logins";
import * as cloudflare from "@/lib/remark/cloudflare";
import * as dbMarkers from "@/lib/remark/db-markers";
import * as instanceDb from "@/lib/remark/instance-db";
import * as jira from "@/lib/remark/jira";
import * as s3 from "@/lib/remark/s3";
import * as ssh from "@/lib/remark/ssh";
import * as targets from "@/lib/remark/targets";
import {
  messageOf,
  REMARK_STEPS,
  type RemarkContext,
  type RemarkItem,
  type RemarkStep,
  type RemarkStepModule,
} from "@/lib/remark/types";
import * as woodpecker from "@/lib/remark/woodpecker";

/** Every step's module; a new step is one line here. */
export const REMARK_MODULES: Record<RemarkStep, RemarkStepModule> = {
  ssh,
  "db-markers": dbMarkers,
  "assistant-logins": assistantLogins,
  cloudflare,
  targets,
  s3,
  woodpecker,
  jira,
  "instance-db": instanceDb,
};

export type RemarkItemResult = RemarkItem & {
  /** planned: dry run; converted / failed: --apply. */
  status: "planned" | "converted" | "failed";
  error?: string;
};

export type RemarkStepReport = {
  step: RemarkStep;
  items: RemarkItemResult[];
  /** Targets the plan could not read, and a plan that failed as a whole. */
  errors: { target: string; message: string }[];
};

export type RemarkReport = {
  apply: boolean;
  steps: RemarkStepReport[];
  failed: boolean;
};

/**
 * Plans each step (in REMARK_STEPS order) and, with `apply`, converts its
 * items one by one. A failing target, item or step is recorded and the run
 * goes on; `failed` says whether anything failed.
 */
export async function runRemark(
  base: Omit<RemarkContext, "log"> & {
    log?: Pick<RemarkContext["log"], "info">;
  },
  opts: { apply: boolean; steps?: readonly RemarkStep[] }
): Promise<RemarkReport> {
  const wanted = opts.steps?.length ? new Set(opts.steps) : null;
  const reports: RemarkStepReport[] = [];
  for (const step of REMARK_STEPS) {
    if (wanted && !wanted.has(step)) continue;
    const module = REMARK_MODULES[step];
    const report: RemarkStepReport = { step, items: [], errors: [] };
    reports.push(report);
    const ctx: RemarkContext = {
      legacy: base.legacy,
      db: base.db,
      log: {
        info: (message) => base.log?.info(`[${step}] ${message}`),
        error: (target, message) => report.errors.push({ target, message }),
      },
    };
    let items: RemarkItem[];
    try {
      items = await module.plan(ctx);
    } catch (error) {
      report.errors.push({ target: step, message: messageOf(error) });
      continue;
    }
    for (const item of items) {
      if (!opts.apply) {
        report.items.push({ ...item, status: "planned" });
        continue;
      }
      try {
        await module.apply(ctx, item);
        report.items.push({ ...item, status: "converted" });
      } catch (error) {
        report.items.push({
          ...item,
          status: "failed",
          error: messageOf(error),
        });
      }
    }
  }
  return {
    apply: opts.apply,
    steps: reports,
    failed: reports.some(
      (r) => r.errors.length > 0 || r.items.some((i) => i.status === "failed")
    ),
  };
}

/** The report as the CLI prints it: grouped by step, one line per item. */
export function formatRemarkReport(report: RemarkReport): string[] {
  const lines = [
    report.apply
      ? "menara remark --apply"
      : "menara remark (dry run: nothing was changed; --apply converts)",
  ];
  for (const step of report.steps) {
    lines.push(`${step.step}: ${step.items.length} item(s)`);
    for (const item of step.items) {
      const status = item.status === "planned" ? "" : ` [${item.status}]`;
      const error = item.error ? `: ${item.error}` : "";
      lines.push(
        `  ${item.target}: ${item.from} -> ${item.to}${status}${error}`
      );
    }
    for (const e of step.errors) {
      lines.push(`  ${e.target}: could not be read: ${e.message}`);
    }
  }
  return lines;
}
