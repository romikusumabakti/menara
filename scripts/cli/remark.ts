// `menara remark [--apply] [--step <s>…]`: converts what this instance wrote
// under the product's previous name on the systems it owns (spec G4). A dry
// run by default; needs MENARA_LEGACY_NAME (exit 2 without it).
import { legacy } from "@/lib/legacy";
import {
  isRemarkStep,
  REMARK_STEPS,
  type RemarkStep,
} from "@/lib/remark/types";

export const REMARK_USAGE = `Usage: menara remark [--apply] [--step <step>]... [--finish]
  (in the image: bun dist/cli.js remark …)

Lists, per step, every trace of the previous product name this instance owns
(MENARA_LEGACY_NAME, old instance name MENARA_LEGACY_INSTANCE) and what it
becomes. Nothing is changed without --apply; a converted item is not listed
again, so a rerun is safe. --step limits the run to the given steps:
  ${REMARK_STEPS.join(", ")}
--finish (removing legacy CI secrets) is not available yet.
Exit 0: done. Exit 1: an item or target failed (the others still ran), or
invalid arguments. Exit 2: MENARA_LEGACY_NAME is not set.`;

export type RemarkArgs = {
  apply: boolean;
  finish: boolean;
  steps: string[];
};

/** The parsed arguments, or null when they are invalid. */
export function parseRemarkArgs(args: string[]): RemarkArgs | null {
  const parsed: RemarkArgs = { apply: false, finish: false, steps: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--finish") parsed.finish = true;
    else if (arg === "--step") {
      const step = args[++i];
      if (step === undefined || step.startsWith("--")) return null;
      parsed.steps.push(step);
    } else return null;
  }
  return parsed;
}

type Io = { out: (line: string) => void; err: (line: string) => void };

const consoleIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export async function runRemarkCommand(
  args: string[],
  io: Io = consoleIo
): Promise<number> {
  if (args.includes("--help")) {
    io.out(REMARK_USAGE);
    return 0;
  }
  const parsed = parseRemarkArgs(args);
  if (!parsed) {
    io.err(REMARK_USAGE);
    return 1;
  }
  const l = legacy();
  if (!l) {
    io.err(
      "MENARA_LEGACY_NAME is not set (or invalid): there is nothing to convert"
    );
    return 2;
  }
  if (parsed.finish) {
    io.err("remark --finish is not available yet");
    return 1;
  }
  // Loaded here so `--help` and the checks above need no database.
  const [{ runRemark, stepModule, formatRemarkReport }, { db }] =
    await Promise.all([import("@/lib/remark/run"), import("@/lib/db")]);
  const steps: RemarkStep[] = [];
  for (const step of parsed.steps) {
    if (!isRemarkStep(step)) {
      io.err(`Unknown step: ${step}\n\n${REMARK_USAGE}`);
      return 1;
    }
    if (!stepModule(step)) {
      io.err(`Step ${step} is not available yet`);
      return 1;
    }
    steps.push(step);
  }
  const report = await runRemark(
    { legacy: l, db, log: { info: io.err } },
    { apply: parsed.apply, steps }
  );
  for (const line of formatRemarkReport(report)) io.out(line);
  return report.failed ? 1 : 0;
}
