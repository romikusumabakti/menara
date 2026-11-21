import type { Legacy } from "@/lib/legacy";
import { shq } from "@/lib/sh";
import { COMPOSE_OVERLAY_FILE } from "@/lib/variables/compose-overlay";

/**
 * Shell fragments for the transition: a target directory may be deployed to by
 * an install already on Menara and by one still on the previous product name,
 * so a script with legacy config also holds the previous name's lock and moves
 * the previous name's persistent files to the Menara names before using them.
 * Without legacy config none of this is emitted.
 */

/** Takes `lockFile` on `fd`, waiting `waitSeconds`; the script fails with `DEPLOY LOCKED` otherwise. */
export function lockLines(
  fd: number,
  lockFile: string,
  waitSeconds: number
): string[] {
  return [
    `exec ${fd}>${shq(lockFile)}`,
    `flock -w ${waitSeconds} ${fd} || { echo 'DEPLOY LOCKED'; exit 1; }`,
  ];
}

/**
 * Renames `oldPath` to `newPath` when the old one exists and the new one does
 * not, so a file already written under the Menara name is never overwritten.
 * The `if` form keeps a missing source from tripping `set -e`.
 */
export function moveIfLegacyLine(
  oldPath: string,
  newPath: string,
  failMessage: string
): string {
  const o = shq(oldPath);
  const n = shq(newPath);
  return `if [ -e ${o} ] && [ ! -e ${n} ]; then mv -- ${o} ${n} || { echo ${shq(failMessage)}; exit 1; }; fi`;
}

/**
 * The persistent files an install on the previous name leaves in a compose
 * deploy dir, as `[old, new]` names relative to it: the kept `.env` copies
 * and, when the target has a managed overlay, the overlay and its copy.
 */
export function legacyComposeFiles(
  l: Legacy,
  overlay: boolean
): [string, string][] {
  const pairs: [string, string][] = [
    [`.env.${l.name}-unmanaged`, ".env.menara-unmanaged"],
    [`.env.${l.name}-prev`, ".env.menara-prev"],
  ];
  if (overlay) {
    pairs.push(
      [`compose.${l.name}.yaml`, COMPOSE_OVERLAY_FILE],
      [
        `compose.${l.name}.yaml.${l.name}-prev`,
        `${COMPOSE_OVERLAY_FILE}.menara-prev`,
      ]
    );
  }
  return pairs;
}

/**
 * The previous name's copy of the last deployed artifact, as `[old, new]`
 * absolute paths: `<dir>/.<legacy>-prev` for a jar target, the sibling
 * `<root>.<legacy>-prev` for a static web root.
 */
export function legacyPrevPath(
  l: Legacy,
  kind: "jar" | "static",
  dir: string
): [string, string] {
  return kind === "jar"
    ? [`${dir}/.${l.name}-prev`, `${dir}/.menara-prev`]
    : [`${dir}.${l.name}-prev`, `${dir}.menara-prev`];
}
