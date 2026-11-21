// Minimal Cloudflare REST client — the DNS-record calls this feature needs
// (plus a token check, and the reads and comment update `menara remark`
// uses on the records it made).
//
// This is deliberately not the Cloudflare SDK: the whole surface is a few
// endpoints, and a dependency that can reach every Cloudflare product is a
// poor match for a credential scoped to `Zone:DNS:Edit` on one zone.
//
// Creating the CNAME through the API is what lets Menara avoid `cert.pem`
// entirely. `cloudflared tunnel route dns` does exactly what createCnameRecord
// does below, but it authenticates with the account-wide origin certificate —
// a credential that can publish a hostname anywhere in the zone and which the
// operator's runbook deliberately shreds after every use. A scoped API token
// is the smaller thing to keep.

import {
  CloudflareApiError,
  describeCloudflareErrors,
  request,
  requestWithInfo,
} from "@/lib/cloudflare/request";

// Re-exported: callers and tests import the error type and its formatter from
// here, and the helper itself now lives in lib/cloudflare/request.ts.
export { CloudflareApiError, describeCloudflareErrors };

export type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  comment?: string | null;
};

/**
 * The CNAME target that routes a hostname into a tunnel. Cloudflare resolves
 * `<tunnel-id>.cfargotunnel.com` internally — it has no public A record, which
 * is why the record must be proxied to work at all.
 */
export function cnameTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

/**
 * Confirm the token works and carries the permissions this feature needs, by
 * listing one record from the zone it is scoped to. Backs the "Test" button on
 * the zone form: a token pasted with a typo, or scoped to the wrong zone, is
 * far better caught here than halfway through publishing a hostname.
 */
export async function verifyZoneAccess(zone: {
  zoneId: string;
  apiToken: string;
}): Promise<void> {
  await request<DnsRecord[]>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records?per_page=1`
  );
}

/** The DNS record for `name`, or null when the name is free. */
export async function findDnsRecord(
  zone: { zoneId: string; apiToken: string },
  name: string
): Promise<DnsRecord | null> {
  const records = await request<DnsRecord[]>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records?name=${encodeURIComponent(name)}`
  );
  return records[0] ?? null;
}

/**
 * Create the proxied CNAME that points `name` at `tunnelId`.
 *
 * `proxied: true` is not a preference. An unproxied record would hand out
 * `<id>.cfargotunnel.com` to the public resolver, which resolves to nothing:
 * the tunnel is only reachable from inside Cloudflare's edge.
 */
export async function createCnameRecord(
  zone: { zoneId: string; apiToken: string },
  options: { name: string; tunnelId: string; comment?: string }
): Promise<DnsRecord> {
  return request<DnsRecord>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: options.name,
        content: cnameTarget(options.tunnelId),
        proxied: true,
        // 1 = "automatic". Proxied records are served from the edge, so the
        // origin TTL is not what clients observe anyway.
        ttl: 1,
        comment: options.comment,
      }),
    }
  );
}

/** The record with this id, or null when it is gone. */
export async function getDnsRecord(
  zone: { zoneId: string; apiToken: string },
  recordId: string
): Promise<DnsRecord | null> {
  try {
    return await request<DnsRecord>(
      zone.apiToken,
      `/zones/${encodeURIComponent(zone.zoneId)}/dns_records/${encodeURIComponent(recordId)}`
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** Every record of the zone whose content is exactly `content`, across pages. */
export async function listDnsRecordsByContent(
  zone: { zoneId: string; apiToken: string },
  content: string
): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const query = new URLSearchParams({
      content,
      page: String(page),
      per_page: "100",
    });
    const { result, info } = await requestWithInfo<DnsRecord[]>(
      zone.apiToken,
      `/zones/${encodeURIComponent(zone.zoneId)}/dns_records?${query}`
    );
    records.push(...result);
    totalPages = info.total_pages ?? 1;
    page++;
  } while (page <= totalPages);
  // The filter is exact on Cloudflare's side; the check keeps it so here.
  return records.filter((record) => record.content === content);
}

/** Sets a record's comment and leaves the rest of it as it is (PATCH). */
export async function setDnsRecordComment(
  zone: { zoneId: string; apiToken: string },
  recordId: string,
  comment: string
): Promise<DnsRecord> {
  return request<DnsRecord>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    { method: "PATCH", body: JSON.stringify({ comment }) }
  );
}

export async function deleteDnsRecord(
  zone: { zoneId: string; apiToken: string },
  recordId: string
): Promise<void> {
  await request<{ id: string }>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    { method: "DELETE" }
  );
}

export type DnsCheck =
  | { state: "ok"; record: DnsRecord }
  | { state: "missing" }
  | { state: "mismatch"; record: DnsRecord }
  | { state: "error"; message: string };

/**
 * Classify the DNS side of one hostname for the ingress table.
 *
 * `mismatch` is the case worth surfacing loudly: a record that exists but does
 * not point at this tunnel means traffic for a hostname listed in this config
 * is going somewhere else entirely.
 */
export async function checkDnsRecord(
  zone: { zoneId: string; apiToken: string },
  options: { name: string; tunnelId: string }
): Promise<DnsCheck> {
  try {
    const record = await findDnsRecord(zone, options.name);
    if (!record) return { state: "missing" };
    if (
      record.type !== "CNAME" ||
      record.content !== cnameTarget(options.tunnelId)
    ) {
      return { state: "mismatch", record };
    }
    return { state: "ok", record };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
