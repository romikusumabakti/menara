import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { SearchRecord } from "@/lib/mcp/oauth-query";
import { api } from "@/web/api/client";

/** The verified client, scopes and account for the consent page. */
export async function getConsentInfo(signedQuery: SearchRecord) {
  return parseResponse(
    api.api.oauth["consent-info"].$get({ query: signedQuery })
  );
}

export const consentInfoQuery = (signedQuery: SearchRecord) =>
  queryOptions({
    queryKey: ["oauth", "consentInfo", signedQuery],
    queryFn: () => getConsentInfo(signedQuery),
    // One authorize request, signed for a few minutes: nothing to refresh.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
