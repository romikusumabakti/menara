import { servers, sshKeys } from "@/lib/db/schema";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";
import { openSsh } from "@/lib/ssh";
import { sshTarget } from "@/lib/ssh-connect";
import { keyMarker, legacyKeyMarker, serverKeyLock } from "@/lib/ssh-keys";
import {
  proveKeyLogin,
  readAuthorizedKeys,
  SSH_TUNING,
  writeAuthorizedKeys,
} from "@/server/services/server-keys";

// Step ssh: on every key server, the authorized_keys line of one of our keys
// that still carries `<legacy>:<old instance>:<keyId>` gets the same line
// with `menara:<instance>:<keyId>`. Lines are matched by their marker
// literally (isOurs would treat both as the same key and replace one with
// the other in one write). Order on apply: add the new line next to the old
// one, prove a fresh login with the key, remove the old line, prove again;
// a failed proof leaves the legacy line in place.

const AS = { actor: "system" } as const;

/** The last field of a non-comment line, where a marker sits. */
function markerOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  return trimmed.split(/\s+/).at(-1) ?? null;
}

function lines(content: string): string[] {
  const all = content.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

function joined(all: string[]): string {
  return all.length ? `${all.join("\n")}\n` : "";
}

/** The first line whose marker is exactly `marker` (without a trailing \r). */
export function lineWithMarker(content: string, marker: string): string | null {
  const line = lines(content).find((l) => markerOf(l) === marker);
  return line === undefined ? null : line.replace(/\r$/, "");
}

/** `line` with its marker `from` replaced by `to`; options and key unchanged. */
export function remarkedLine(line: string, from: string, to: string): string {
  const trimmed = line.trimEnd();
  if (!trimmed.endsWith(from))
    throw new Error("the line does not end in its marker");
  return `${trimmed.slice(0, trimmed.length - from.length)}${to}`;
}

/** `content` with `line` appended (after a newline when the file lacks one). */
export function withLine(content: string, line: string): string {
  return joined([...lines(content), line]);
}

/** `content` without the lines whose marker is exactly `marker`. */
export function withoutMarker(content: string, marker: string): string {
  return joined(lines(content).filter((l) => markerOf(l) !== marker));
}

const targetOf = (serverId: string) => `servers/${serverId}`;

function serverIdOf(target: string): string {
  const match = /^servers\/([0-9a-f-]+)$/i.exec(target);
  if (!match?.[1]) throw new Error(`not an ssh target: ${target}`);
  return match[1];
}

async function keyServers(ctx: RemarkContext) {
  const rows = await ctx.db.select().from(servers);
  return rows.filter((s) => s.auth === "key" && s.sshKeyId !== null);
}

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const keys = await ctx.db.select({ id: sshKeys.id }).from(sshKeys);
  const markers = keys.flatMap((k) => {
    const from = legacyKeyMarker(k.id, ctx.legacy);
    return from ? [{ from, to: keyMarker(k.id) }] : [];
  });
  if (markers.length === 0) return [];
  const items: RemarkItem[] = [];
  for (const server of await keyServers(ctx)) {
    const target = targetOf(server.id);
    let content: string;
    try {
      // A dry run writes nothing, not even to Menara's own database.
      const ssh = await openSsh(
        sshTarget({ ...server, password: null }),
        SSH_TUNING,
        { ...AS, readOnly: true }
      );
      try {
        content = await readAuthorizedKeys(ssh);
      } finally {
        ssh.dispose();
      }
    } catch (error) {
      ctx.log.error(target, messageOf(error));
      continue;
    }
    for (const m of markers) {
      if (lineWithMarker(content, m.from) !== null) {
        items.push({ step: "ssh", target, ...m });
      }
    }
  }
  return items;
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const serverId = serverIdOf(item.target);
  const keyId = item.to.slice(item.to.lastIndexOf(":") + 1);
  if (
    legacyKeyMarker(keyId, ctx.legacy) !== item.from ||
    keyMarker(keyId) !== item.to
  ) {
    throw new Error("the item's markers are not this instance's");
  }
  const release = await serverKeyLock(serverId);
  if (!release)
    throw new Error("another key operation on this server is running");
  try {
    const [server] = (await keyServers(ctx)).filter((s) => s.id === serverId);
    if (!server) throw new Error("the server is gone or no longer uses a key");
    const target = sshTarget({ ...server, password: null });
    const ssh = await openSsh(target, SSH_TUNING, AS);
    try {
      await convert(
        ssh,
        target,
        keyId,
        item,
        `server ${server.name} (${server.id})`
      );
    } finally {
      ssh.dispose();
    }
  } finally {
    await release().catch(() => {});
  }
}

type Session = Awaited<ReturnType<typeof openSsh>>;

async function convert(
  ssh: Session,
  target: ReturnType<typeof sshTarget>,
  keyId: string,
  item: RemarkItem,
  where: string
): Promise<void> {
  const proven = async () => (await proveKeyLogin(target, keyId, AS)) === null;
  const content = await readAuthorizedKeys(ssh);
  const old = lineWithMarker(content, item.from);
  if (old === null) {
    // Converted by an earlier run, or removed by hand meanwhile.
    if (lineWithMarker(content, item.to) !== null) return;
    throw new Error("the legacy line is gone and no new line is there");
  }
  const added = lineWithMarker(content, item.to) === null;
  if (added) {
    await writeAuthorizedKeys(
      ssh,
      withLine(content, remarkedLine(old, item.from, item.to))
    );
  }
  if (!(await proven())) {
    if (added) {
      try {
        await writeAuthorizedKeys(
          ssh,
          withoutMarker(await readAuthorizedKeys(ssh), item.to)
        );
      } catch {
        throw new Error(
          `${where}: key login failed after adding the new line, and removing it failed: both lines remain`
        );
      }
    }
    throw new Error(
      "key login failed after adding the new line; the legacy line is kept"
    );
  }
  await writeAuthorizedKeys(
    ssh,
    withoutMarker(await readAuthorizedKeys(ssh), item.from)
  );
  if (!(await proven())) {
    try {
      await writeAuthorizedKeys(
        ssh,
        withLine(await readAuthorizedKeys(ssh), old)
      );
    } catch {
      throw new Error(
        `${where}: key login failed with the new line alone, and the legacy line could not be restored: only the new line remains`
      );
    }
    throw new Error(
      "key login failed with the new line alone; the legacy line was put back"
    );
  }
}
