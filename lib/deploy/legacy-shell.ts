import { shq } from "@/lib/sh";

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
