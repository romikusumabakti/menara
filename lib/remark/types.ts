import type { db } from "@/lib/db";
import type { Legacy } from "@/lib/legacy";

// `menara remark`: converts the traces a migrated instance left under the
// previous product name on the systems it owns (spec G4). Each step plans
// one item per trace without writing anything, then converts one item at a
// time; a converted item is never planned again.

/** Every step, in the order a full run takes them. */
export const REMARK_STEPS = [
  "ssh",
  "db-markers",
  "assistant-logins",
  "cloudflare",
  "targets",
  "s3",
  "woodpecker",
  "jira",
  "instance-db",
] as const;

export type RemarkStep = (typeof REMARK_STEPS)[number];

/**
 * One trace to convert. `target` names the thing it lives on as a path of
 * ids the step resolves again on apply (e.g. `servers/<id>`); `from` and
 * `to` are the old and new values. Never a secret: the report prints all
 * four.
 */
export type RemarkItem = {
  step: RemarkStep;
  target: string;
  from: string;
  to: string;
};

export type RemarkLog = {
  info(message: string): void;
  /**
   * A target the step could not read while planning (the other targets go
   * on); counted as a failure, so the run exits non-zero. The message must
   * carry no secret.
   */
  error(target: string, message: string): void;
};

export type RemarkContext = {
  legacy: Legacy;
  db: typeof db;
  log: RemarkLog;
};

export type RemarkStepModule = {
  plan(ctx: RemarkContext): Promise<RemarkItem[]>;
  /** Converts one planned item; throws (without secrets) when it could not. */
  apply(ctx: RemarkContext, item: RemarkItem): Promise<void>;
};

export function isRemarkStep(value: string): value is RemarkStep {
  return (REMARK_STEPS as readonly string[]).includes(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
