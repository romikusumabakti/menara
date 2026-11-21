import {
  type CloudflareCreds,
  getAccessApp,
  listAccessApps,
  renameAccessApp,
} from "@/lib/cloudflare/api";
import {
  cloudflareAccounts,
  cloudflareZones,
  environmentDomains,
  environments,
  tunnels,
} from "@/lib/db/schema";
import { type Legacy, legacyPattern } from "@/lib/legacy";
import type { RemarkContext, RemarkItem } from "@/lib/remark/types";
import { messageOf } from "@/lib/remark/types";
import { decryptSecret } from "@/lib/secrets";
import {
  cnameTarget,
  type DnsRecord,
  findDnsRecord,
  getDnsRecord,
  listDnsRecordsByContent,
  setDnsRecordComment,
} from "@/lib/tunnels/cloudflare";

// Step cloudflare: the names and comments Menara writes on Cloudflare, still
// in the previous product's form:
// - Access apps named `<legacy>:<envId>` (lib/jobs/provision-cloudflare.ts)
//   -> `menara:<envId>`;
// - DNS records of an environment domain with that tag as comment, same;
// - DNS records a locally-managed tunnel's route got, commented
//   `Managed by <Legacy> — <tunnel>` (server/services/tunnels.ts) ->
//   `Managed by Menara — <tunnel>`.
// Only this instance's objects: a tag of one of its environments, or a record
// pointing at one of its tunnels. Tunnel configs carry nothing to convert:
// Menara writes no comment into a remote config or a config.yml.
// Plan only reads; apply re-reads the object and changes it only while it
// still holds the planned value.

type Zone = { zoneId: string; apiToken: string };

const MANAGED_BY = "Managed by ";
const MANAGED_BY_SEP = " — ";

const legacyTag = (l: Legacy, envId: string) => `${l.name}:${envId}`;
const menaraTag = (envId: string) => `menara:${envId}`;

/** `Managed by <Legacy> — <rest>` as `Managed by Menara — <rest>`, else null. */
export function menaraManagedBy(comment: string, l: Legacy): string | null {
  if (!comment.startsWith(MANAGED_BY)) return null;
  const at = comment.indexOf(MANAGED_BY_SEP, MANAGED_BY.length);
  if (at === -1) return null;
  const product = comment.slice(MANAGED_BY.length, at);
  const whole = new RegExp(`^(?:${legacyPattern(l).source})$`, "i");
  if (!whole.test(product)) return null;
  return `${MANAGED_BY}Menara${comment.slice(at)}`;
}

/** The env id of `from` -> `to` when it is a tag conversion of ours. */
function tagEnv(
  l: Legacy,
  envIds: Set<string>,
  from: string,
  to: string
): string | null {
  const envId = to.slice("menara:".length);
  return envIds.has(envId) &&
    from === legacyTag(l, envId) &&
    to === menaraTag(envId)
    ? envId
    : null;
}

async function loadAccount(
  ctx: RemarkContext
): Promise<CloudflareCreds | null> {
  const [row] = await ctx.db.select().from(cloudflareAccounts).limit(1);
  return row
    ? { accountId: row.accountId, apiToken: decryptSecret(row.apiToken) }
    : null;
}

async function environmentIds(ctx: RemarkContext): Promise<Set<string>> {
  const rows = await ctx.db.select({ id: environments.id }).from(environments);
  return new Set(rows.map((r) => r.id));
}

/** The zone's own token, else the account's (as server/services/tunnels.ts). */
function zoneOf(
  row: { zoneId: string; apiToken: string | null },
  account: CloudflareCreds | null
): Zone {
  if (row.apiToken) {
    return { zoneId: row.zoneId, apiToken: decryptSecret(row.apiToken) };
  }
  if (!account) {
    throw new Error(
      "the zone has no API token and no Cloudflare account is set"
    );
  }
  return { zoneId: row.zoneId, apiToken: account.apiToken };
}

const appTarget = (appId: string) => `cloudflare/access-apps/${appId}`;
const zoneTarget = (zoneRowId: string) => `cloudflare/zones/${zoneRowId}`;
const recordTarget = (zoneRowId: string, recordId: string) =>
  `${zoneTarget(zoneRowId)}/dns-records/${recordId}`;

export async function plan(ctx: RemarkContext): Promise<RemarkItem[]> {
  const l = ctx.legacy;
  const envIds = await environmentIds(ctx);
  const account = await loadAccount(ctx);
  const items: RemarkItem[] = [];

  if (account) {
    try {
      for (const app of await listAccessApps(account)) {
        const envId = app.name.startsWith(`${l.name}:`)
          ? app.name.slice(l.name.length + 1)
          : null;
        if (envId && envIds.has(envId) && app.name === legacyTag(l, envId)) {
          items.push({
            step: "cloudflare",
            target: appTarget(app.id),
            from: app.name,
            to: menaraTag(envId),
          });
        }
      }
    } catch (error) {
      ctx.log.error("cloudflare/access-apps", messageOf(error));
    }
  }

  const [zones, domains, tunnelRows] = await Promise.all([
    ctx.db.select().from(cloudflareZones),
    ctx.db.select().from(environmentDomains),
    ctx.db.select().from(tunnels),
  ]);
  const seen = new Set<string>();
  for (const zoneRow of zones) {
    const zoneDomains = domains.filter(
      (d) =>
        d.kind === "tunnel" &&
        d.zoneId === zoneRow.id &&
        envIds.has(d.environmentId)
    );
    const zoneTunnels = tunnelRows.filter((t) => t.zoneId === zoneRow.id);
    if (zoneDomains.length === 0 && zoneTunnels.length === 0) continue;
    const found: RemarkItem[] = [];
    const add = (record: DnsRecord, to: string) => {
      if (seen.has(record.id) || !record.comment) return;
      seen.add(record.id);
      found.push({
        step: "cloudflare",
        target: recordTarget(zoneRow.id, record.id),
        from: record.comment,
        to,
      });
    };
    try {
      const zone = zoneOf(zoneRow, account);
      for (const d of zoneDomains) {
        const record = d.dnsRecordId
          ? await getDnsRecord(zone, d.dnsRecordId)
          : await findDnsRecord(zone, d.hostname);
        if (record?.comment === legacyTag(l, d.environmentId)) {
          add(record, menaraTag(d.environmentId));
        }
      }
      for (const t of zoneTunnels) {
        const records = await listDnsRecordsByContent(
          zone,
          cnameTarget(t.tunnelId)
        );
        for (const record of records) {
          const to = record.comment ? menaraManagedBy(record.comment, l) : null;
          if (to) add(record, to);
        }
      }
    } catch (error) {
      ctx.log.error(zoneTarget(zoneRow.id), messageOf(error));
      continue;
    }
    items.push(...found);
  }
  return items;
}

export async function apply(
  ctx: RemarkContext,
  item: RemarkItem
): Promise<void> {
  const l = ctx.legacy;
  const envIds = await environmentIds(ctx);
  const account = await loadAccount(ctx);

  const app = /^cloudflare\/access-apps\/([^/]+)$/.exec(item.target);
  if (app?.[1]) {
    if (!tagEnv(l, envIds, item.from, item.to)) {
      throw new Error("the item's names are not this instance's");
    }
    if (!account) throw new Error("no Cloudflare account is set");
    const current = await getAccessApp(account, account.accountId, app[1]);
    if (!current) throw new Error("the Access app is gone");
    if (current.name === item.to) return;
    if (current.name !== item.from) {
      throw new Error(`the Access app is no longer named ${item.from}`);
    }
    if (!(await renameAccessApp(account, app[1], item.to))) {
      throw new Error("the Access app is gone");
    }
    return;
  }

  const rec = /^cloudflare\/zones\/([^/]+)\/dns-records\/([^/]+)$/.exec(
    item.target
  );
  if (!rec?.[1] || !rec[2]) {
    throw new Error(`not a cloudflare target: ${item.target}`);
  }
  const [zoneRowId, recordId] = [rec[1], rec[2]];
  const zoneRow = (await ctx.db.select().from(cloudflareZones)).find(
    (z) => z.id === zoneRowId
  );
  if (!zoneRow) throw new Error("the zone is gone");
  const zone = zoneOf(zoneRow, account);
  const record = await getDnsRecord(zone, recordId);
  if (!record) throw new Error("the DNS record is gone");
  if (record.comment === item.to) return;
  if (record.comment !== item.from) {
    throw new Error(`the DNS record's comment is no longer ${item.from}`);
  }
  const ours =
    tagEnv(l, envIds, item.from, item.to) !== null ||
    (menaraManagedBy(item.from, l) === item.to &&
      (await ctx.db.select().from(tunnels)).some(
        (t) =>
          t.zoneId === zoneRowId && record.content === cnameTarget(t.tunnelId)
      ));
  if (!ours) throw new Error("the DNS record is not this instance's");
  await setDnsRecordComment(zone, recordId, item.to);
}
