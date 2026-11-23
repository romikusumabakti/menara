import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireSession } from "@/lib/auth-session";
import { signedOAuthParams, toQueryString } from "@/lib/mcp/oauth-query";
import { isMcpScope } from "@/lib/mcp/scopes";
import { CodedHTTPException } from "@/server/errors";
import { sessionRouter } from "@/server/router";
import { query } from "@/server/validation";

const searchSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())])
);

function invalid(): never {
  throw new CodedHTTPException(
    400,
    "oauthConsentInvalid",
    "This authorization request is invalid or has expired. Start again from the app."
  );
}

/** The host of a URL, or null when it is not one (a registered client's random id). */
function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * What the consent page shows (/<locale>/oauth/consent). The query is the
 * signed authorize query better-auth redirected the browser with; it is
 * verified here, so the page never renders a client, scope or redirect the
 * authorization server did not sign.
 *
 * The client's name is self-asserted (it comes from its metadata document),
 * so the page also shows the host of its client_id — the URL that document
 * lives at — and of its redirect. No logo is served: a hotlinked image would
 * be one more thing the client controls on our page.
 */
export const oauthConsentRouter = sessionRouter().get(
  "/consent-info",
  query(searchSchema),
  async (c) => {
    const signed = signedOAuthParams(c.req.valid("query"));
    if (!signed) invalid();
    const oauthQuery = toQueryString(signed);
    const { secret } = await auth.$context;
    if (!(await verifyOAuthQueryParams(oauthQuery, secret))) invalid();

    const params = new URLSearchParams(oauthQuery);
    const clientId = params.get("client_id");
    if (!clientId) invalid();
    let client: Awaited<ReturnType<typeof auth.api.getOAuthClientPublic>>;
    try {
      client = await auth.api.getOAuthClientPublic({
        query: { client_id: clientId },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      // Unknown or disabled since the authorize request was signed.
      if (isAPIError(error) && error.statusCode === 404) invalid();
      throw error;
    }

    const requested = (params.get("scope") ?? "").split(" ").filter(Boolean);
    const session = await requireSession();
    c.header("Cache-Control", "private, no-store");
    return c.json({
      client: {
        name: client.client_name ?? null,
        host: hostOf(clientId),
        logoUrl: null,
      },
      redirectHost: hostOf(params.get("redirect_uri")),
      scopes: requested.filter(isMcpScope),
      offlineAccess: requested.includes("offline_access"),
      account: { name: session.user.name, email: session.user.email },
    });
  }
);
