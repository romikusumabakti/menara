import type { Context, MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";

// Cross-site request forgery guard for every state-changing request.
//
// Next server actions refused a POST whose Origin didn't match the host; the
// API needs the same, because a bodyless POST (mark-all-notifications-read,
// clear-status) or a form-encoded one can be fired by a plain <form> on any
// site, with the user's cookie attached.
//
// hono/csrf only looks at requests a form can send — non-GET/HEAD with a
// form-encoded, multipart or text/plain body (a missing Content-Type counts as
// text/plain). JSON can't come from a form, so JSON callers that send no Origin
// — the Jira webhook — pass untouched. A checked request passes when the
// browser says `Sec-Fetch-Site: same-origin`, or when its Origin is the app's.
//
// The app's origin is BETTER_AUTH_URL's, the public URL auth already builds its
// callbacks from: behind the tunnel and Caddy the request URL is the
// container's, so comparing against it would refuse every real user. Unset (a
// local `bun run dev:server`) falls back to the request URL's own origin, which
// is what the browser sees there.
//
// The variable is read per request (tests and a re-configured process see the
// current value) but parsed once per distinct value. A malformed value — which
// validateEnv already reports at boot — trusts no Origin, so checked requests
// fall back to Sec-Fetch-Site alone instead of failing with a 500 each time.
let parsed: { raw: string; origin: string | null } | undefined;

function configuredOrigin(raw: string): string | null {
  if (parsed?.raw !== raw) {
    let origin: string | null = null;
    try {
      origin = new URL(raw).origin;
    } catch {
      console.error("BETTER_AUTH_URL is not a valid URL; trusting no Origin");
    }
    parsed = { raw, origin };
  }
  return parsed.origin;
}

function isAppOrigin(origin: string, c: Context): boolean {
  const configured = process.env.BETTER_AUTH_URL;
  if (!configured) return origin === new URL(c.req.url).origin;
  return origin === configuredOrigin(configured);
}

// OAuth endpoints an MCP agent calls itself, from its own process or server,
// with a form-encoded body and no Menara cookie: the agent authenticates with
// its PKCE verifier or its token, not a session, so there is nothing for a
// forged request to borrow. A browser-based agent sends its own Origin.
const CSRF_EXEMPT = new Set([
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/revoke",
  "/api/mcp",
]);

const guard = csrf({ origin: isAppOrigin });

export const csrfGuard: MiddlewareHandler = (c, next) =>
  CSRF_EXEMPT.has(c.req.path) ? next() : guard(c, next);
