// The signed OAuth query better-auth hands the sign-in and consent pages:
// the original authorize parameters plus `exp`, `ba_iat`, a `ba_param` entry
// naming each signed parameter, and the HMAC in `sig`. Pure and
// dependency-free: the pages, the router's search validation and the
// consent-info route all read it.

/** A parsed query string: a repeated key is an array (web/search-params). */
export type SearchRecord = Record<string, string | string[]>;

const SIGNATURE = "sig";
const SIGNED_NAMES = "ba_param";

function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * The signed OAuth parameters in `search` (`sig`, `ba_param` and every name
 * `ba_param` lists), or null when it carries none. Mirrors oauth-provider's
 * own client plugin, so what a page keeps is exactly what it will send back
 * as `oauth_query`. Anything else in the query is left out.
 */
export function signedOAuthParams(
  search: Record<string, unknown>
): SearchRecord | null {
  const names = new Set(values(search[SIGNED_NAMES]));
  if (values(search[SIGNATURE]).length === 0 || names.size === 0) return null;
  const out: SearchRecord = {};
  for (const [key, value] of Object.entries(search)) {
    if (key !== SIGNATURE && key !== SIGNED_NAMES && !names.has(key)) continue;
    const list = values(value);
    if (list.length === 0) continue;
    out[key] = list.length === 1 ? (list[0] as string) : list;
  }
  return out;
}

/** The parameters as a query string, without the leading `?`. */
export function toQueryString(params: SearchRecord): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      query.append(key, item);
    }
  }
  return query.toString();
}
