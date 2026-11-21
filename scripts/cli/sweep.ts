// `menara sweep [--json]`: read-only report of every trace of the product's
// previous name left on the systems this instance owns and in its database
// (spec G6). Exit 0: none. Exit 1: traces left, a system could not be
// checked, or invalid arguments. Exit 2: MENARA_LEGACY_NAME is not set.
import { legacy } from "@/lib/legacy";

export const SWEEP_USAGE = `Usage: menara sweep [--json]
  (in the image: bun dist/cli.js sweep …)

Read-only. Lists every trace of the previous product name (MENARA_LEGACY_NAME)
still left: what \`remark\` would convert, legacy CI secrets \`remark --finish\`
would delete, and whole-word matches in the text columns of Menara's own
database (history such as the activity log, runs, deployments, job steps and
Assistant chats is not scanned). A system that cannot be read is listed as
"could not check". --json prints [{ system, location, excerpt }].
Exit 0: nothing left. Exit 1: something left or unchecked, or invalid
arguments. Exit 2: MENARA_LEGACY_NAME is not set.`;

type Io = { out: (line: string) => void; err: (line: string) => void };

const consoleIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export async function runSweepCommand(
  args: string[],
  io: Io = consoleIo
): Promise<number> {
  if (args.includes("--help")) {
    io.out(SWEEP_USAGE);
    return 0;
  }
  if (args.some((a) => a !== "--json")) {
    io.err(SWEEP_USAGE);
    return 1;
  }
  const l = legacy();
  if (!l) {
    io.err(
      "MENARA_LEGACY_NAME is not set (or invalid): there is nothing to sweep for"
    );
    return 2;
  }
  // Loaded here so `--help` and the checks above need no database.
  const [{ runSweep, formatSweepReport }, { db }] = await Promise.all([
    import("@/lib/sweep/run"),
    import("@/lib/db"),
  ]);
  const report = await runSweep({ legacy: l, db, log: { info: io.err } });
  if (args.includes("--json")) io.out(JSON.stringify(report.hits, null, 2));
  else for (const line of formatSweepReport(report)) io.out(line);
  return report.failed ? 1 : 0;
}
