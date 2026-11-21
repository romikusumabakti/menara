import { deployTargets, servers } from "@/lib/db/schema";
import {
  existingLockLines,
  legacyComposeFiles,
  legacyPrevPath,
  lockLines,
} from "@/lib/deploy/legacy-shell";
import { type Legacy, legacyPattern } from "@/lib/legacy";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";
import { decryptNullable } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { sshTarget } from "@/lib/ssh-connect";
import { normaliseDeployDir } from "@/lib/teardown/paths";
import { COMPOSE_OVERLAY_FILE } from "@/lib/variables/compose-overlay";

// Step targets: what an install on the previous name left in the deploy dirs
// of this instance's targets.
// - Persistent files under the old name (lib/deploy/legacy-shell.ts lists
//   them) are moved to the Menara name, never over an existing file. The
//   deploy scripts do the same on contact; this covers targets not deployed
//   since the migration.
// - The previous name's deploy lock is removed (deploys take it only while it
//   exists, so once it is gone nothing creates it again).
// - In a compose dir, the generated header line of `.env`, the overlay and
//   their kept copies (`# Managed by <Legacy> — …`, `# Written by <Legacy>; …`)
//   gets the Menara name, and a `COMPOSE_FILE` line naming the old overlay
//   names the new one. In `.env` that happens only once the overlay has been
//   moved, so Compose never reads a file list naming a file that isn't there.
// The plan reads first lines and `COMPOSE_FILE` lines only (no value of a
// `.env` leaves the server) over connections that write nothing to Menara's
// database. Apply holds the target's deploy lock (and the old name's lock
// when one is there), so no deploy runs meanwhile.

const TIMEOUT_MS = 90_000;
const LOCK_WAIT_SECONDS = 60;

/** The compose dir files with a generated header: [Menara name, compose-file line]. */
const HEADER_FILES: [string, boolean][] = [
  [".env", true],
  [".env.menara-prev", true],
  [COMPOSE_OVERLAY_FILE, false],
  [`${COMPOSE_OVERLAY_FILE}.menara-prev`, false],
];

type Target = {
  id: string;
  kind: "compose" | "jar" | "static";
  dir: string;
  server: {
    id: string;
    host: string;
    username: string;
    password: string | null;
    auth: "password" | "key";
  };
};

/** The `to` of an item that removes its `from` path. */
export const REMOVED = "(removed)";

/** The target's deploy lock base: inside a deploy dir, beside a web root. */
function lockBase(t: Target): string {
  return t.kind === "static" ? `${t.dir}.` : `${t.dir}/.`;
}

/** The previous name's deploy lock of the target (absolute). */
function legacyLock(l: Legacy, t: Target): string {
  return `${lockBase(t)}${l.name}-deploy.lock`;
}

/** `[old, new]` absolute paths of the target's old-named files. */
function renames(l: Legacy, t: Target): [string, string][] {
  if (t.kind === "compose") {
    return legacyComposeFiles(l, true).map(([o, n]) => [
      `${t.dir}/${o}`,
      `${t.dir}/${n}`,
    ]);
  }
  return [legacyPrevPath(l, t.kind, t.dir)];
}

/** The old name a header file had (its kept copy's or overlay's), if any. */
function legacyNameOf(l: Legacy, name: string): string | null {
  const pair = legacyComposeFiles(l, true).find(([, n]) => n === name);
  return pair ? pair[0] : null;
}

/**
 * A generated header line (`# Managed by <Legacy> …`, `# Written by
 * <Legacy>…`) with the Menara name; null for any other line, so a comment
 * someone wrote that merely mentions the old name stays as it is.
 */
export function menaraHeader(line: string, l: Legacy): string | null {
  const by = /^# (?:Managed|Written) by ([A-Za-z0-9-]+)/.exec(line);
  if (by?.[1]?.toLowerCase() !== l.name) return null;
  const all = new RegExp(legacyPattern(l).source, "gi");
  const next = line.replace(all, "Menara");
  return next === line ? null : next;
}

/** A `COMPOSE_FILE=` line naming the old overlay, naming the new one; else null. */
export function menaraComposeFile(line: string, l: Legacy): string | null {
  const prefix = "COMPOSE_FILE=";
  if (!line.startsWith(prefix)) return null;
  const old = `compose.${l.name}.yaml`;
  const files = line.slice(prefix.length).split(":");
  if (!files.includes(old)) return null;
  return `${prefix}${files.map((f) => (f === old ? COMPOSE_OVERLAY_FILE : f)).join(":")}`;
}

async function loadTargets(ctx: RemarkContext): Promise<Target[]> {
  const [rows, serverRows] = await Promise.all([
    ctx.db.select().from(deployTargets),
    ctx.db.select().from(servers),
  ]);
  const serverById = new Map(serverRows.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const row of rows) {
    const server = serverById.get(row.serverId);
    if (!server) continue;
    const dir = normaliseDeployDir(row.deployDir);
    // Targets sharing a dir on one server are one place.
    const key = `${server.id}|${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: row.id,
      kind: row.kind,
      dir,
      server: {
        id: server.id,
        host: server.host,
        username: server.username,
        password: decryptNullable(server.password),
        auth: server.auth,
      },
    });
  }
  return out;
}

function run(t: Target, command: string, readOnly: boolean): Promise<string> {
  return executeRemoteCommand(sshTarget(t.server), command, {
    timeoutMs: TIMEOUT_MS,
    secrets: t.server.password ? [t.server.password] : [],
    readOnly,
  });
}

/** Lists the old-named files that exist and, for compose, the header lines. */
function probeScript(l: Legacy, t: Target): string {
  const lines = [
    ...[...renames(l, t).map(([o]) => o), legacyLock(l, t)].map(
      (o) => `if [ -e ${shq(o)} ]; then printf 'E\\t%s\\n' ${shq(o)}; fi`
    ),
  ];
  if (t.kind === "compose") {
    lines.unshift(`cd -- ${shq(t.dir)} 2>/dev/null || exit 0`);
    lines.push(
      // $1 Menara name, $2 old name ('' for none), $3 1 = read COMPOSE_FILE.
      "probe() {",
      '  if [ -f "$1" ]; then f=$1; elif [ -n "$2" ] && [ -f "$2" ]; then f=$2; else return 0; fi',
      '  line=; IFS= read -r line < "$f" || true',
      "  case $line in '#'*) printf 'H\\t%s\\t%s\\n' \"$1\" \"$line\" ;; esac",
      '  if [ "$3" = 1 ]; then',
      "    c=$(grep -m 1 '^COMPOSE_FILE=' \"$f\" || true)",
      '    if [ -n "$c" ]; then printf \'C\\t%s\\t%s\\n\' "$1" "$c"; fi',
      "  fi",
      "}",
      ...HEADER_FILES.map(
        ([name, composeFile]) =>
          `probe ${shq(name)} ${shq(legacyNameOf(l, name) ?? "")} ${composeFile ? 1 : 0}`
      )
    );
  }
  return lines.join("\n");
}

const renameTarget = (t: Target) => `deploy-targets/${t.id}`;
const fileTarget = (t: Target, name: string) =>
  `deploy-targets/${t.id}/${name}`;

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const l = ctx.legacy;
  const items: RemarkItem[] = [];
  for (const t of await loadTargets(ctx)) {
    let output: string;
    try {
      output = await run(t, probeScript(l, t), true);
    } catch (error) {
      ctx.log.error(renameTarget(t), messageOf(error));
      continue;
    }
    const present = new Set<string>();
    const lineItems: RemarkItem[] = [];
    for (const raw of output.split("\n")) {
      const [kind, a = "", ...rest] = raw.split("\t");
      const value = rest.join("\t").replace(/\r$/, "");
      if (kind === "E") present.add(a);
      const to =
        kind === "H"
          ? menaraHeader(value, l)
          : kind === "C"
            ? menaraComposeFile(value, l)
            : null;
      if (to) {
        lineItems.push({
          step: "targets",
          target: fileTarget(t, a),
          from: value,
          to,
        });
      }
    }
    for (const [from, to] of renames(l, t)) {
      if (present.has(from)) {
        items.push({ step: "targets", target: renameTarget(t), from, to });
      }
    }
    const lock = legacyLock(l, t);
    if (present.has(lock)) {
      items.push({
        step: "targets",
        target: renameTarget(t),
        from: lock,
        to: REMOVED,
      });
    }
    items.push(...lineItems);
  }
  return items;
}

/** The target's deploy lock, and the old name's while one is there. */
function lockScript(l: Legacy, t: Target): string[] {
  return [
    "set -eu",
    ...lockLines(9, `${lockBase(t)}menara-deploy.lock`, LOCK_WAIT_SECONDS),
    // Taken only when it exists: remark must not leave a new old-named file.
    ...existingLockLines(6, legacyLock(l, t), LOCK_WAIT_SECONDS),
  ];
}

function outcome(output: string): string {
  return output.trim().split("\n").at(-1) ?? "";
}

/**
 * Removes the previous name's lock while holding it (after Menara's), so a
 * deploy of an install still on the old name never runs meanwhile.
 */
async function applyRemoveLock(
  l: Legacy,
  t: Target,
  item: RemarkItem
): Promise<void> {
  if (item.from !== legacyLock(l, t)) {
    throw new Error("the item's paths are not this target's old-named files");
  }
  // Already gone is done: deploys no longer create it.
  await run(
    t,
    [...lockScript(l, t), `rm -f -- ${shq(item.from)}`].join("\n"),
    false
  );
}

async function applyRename(
  l: Legacy,
  t: Target,
  item: RemarkItem
): Promise<void> {
  if (item.to === REMOVED) {
    await applyRemoveLock(l, t, item);
    return;
  }
  if (!renames(l, t).some(([o, n]) => o === item.from && n === item.to)) {
    throw new Error("the item's paths are not this target's old-named files");
  }
  const o = shq(item.from);
  const n = shq(item.to);
  const result = outcome(
    await run(
      t,
      [
        ...lockScript(l, t),
        `if [ -e ${o} ] && [ ! -e ${n} ]; then mv -- ${o} ${n}; echo moved`,
        `elif [ -e ${n} ] && [ ! -e ${o} ]; then echo done`,
        `elif [ -e ${o} ]; then echo both`,
        "else echo gone; fi",
      ].join("\n"),
      false
    )
  );
  if (result === "both") {
    throw new Error(
      `${item.to} exists too; not overwriting it; remove the legacy copy by hand once the target is healthy`
    );
  }
  if (result === "gone") throw new Error(`${item.from} is gone`);
}

async function applyLine(
  l: Legacy,
  t: Target,
  name: string,
  item: RemarkItem
): Promise<void> {
  const header = HEADER_FILES.find(([n]) => n === name);
  const valid =
    t.kind === "compose" &&
    header !== undefined &&
    (menaraHeader(item.from, l) === item.to ||
      (header[1] && menaraComposeFile(item.from, l) === item.to));
  if (!valid)
    throw new Error("the item is not a generated line of this target");
  const file = shq(`${t.dir}/${name}`);
  // Compose reads .env's file list: it may name the overlay only once the
  // overlay is under that name.
  const guard =
    name === ".env" && item.from.startsWith("COMPOSE_FILE=")
      ? [
          `if [ -e ${shq(`${t.dir}/compose.${l.name}.yaml`)} ] || [ ! -e ${shq(`${t.dir}/${COMPOSE_OVERLAY_FILE}`)} ]; then echo overlay; exit 0; fi`,
        ]
      : [];
  const result = outcome(
    await run(
      t,
      [
        ...lockScript(l, t),
        `export REMARK_FROM=${shq(item.from)} REMARK_TO=${shq(item.to)}`,
        `if [ ! -f ${file} ]; then echo gone; exit 0; fi`,
        ...guard,
        `if grep -qxF -e "$REMARK_FROM" -- ${file}; then`,
        `  tmp=$(mktemp ${shq(`${t.dir}/${name}.menara-remark.`)}XXXXXX)`,
        `  if awk 'BEGIN { f = ENVIRON["REMARK_FROM"]; t = ENVIRON["REMARK_TO"] } !d && $0 == f { print t; d = 1; next } { print }' ${file} > "$tmp" && chmod --reference=${file} "$tmp" && mv -f -- "$tmp" ${file}; then echo rewritten; else rm -f -- "$tmp"; echo failed; exit 1; fi`,
        `elif grep -qxF -e "$REMARK_TO" -- ${file}; then echo done`,
        "else echo changed; fi",
      ].join("\n"),
      false
    )
  );
  if (result === "overlay") {
    throw new Error(
      `the overlay is not under ${COMPOSE_OVERLAY_FILE} yet; COMPOSE_FILE is left as it is`
    );
  }
  if (result === "gone") throw new Error(`${name} is gone`);
  if (result === "changed") {
    throw new Error(`${name} no longer has the planned line`);
  }
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const match = /^deploy-targets\/([0-9a-f-]+)(?:\/(.+))?$/i.exec(item.target);
  if (!match?.[1]) throw new Error(`not a targets target: ${item.target}`);
  const t = (await loadTargets(ctx)).find((x) => x.id === match[1]);
  if (!t) throw new Error("the deploy target is gone");
  if (match[2] === undefined) await applyRename(ctx.legacy, t, item);
  else await applyLine(ctx.legacy, t, match[2], item);
}
