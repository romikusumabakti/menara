import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { twoFactor } from "better-auth/plugins/two-factor";
import { eq } from "drizzle-orm";
import { recordActivity } from "./activity";
import { authActivityFor, clientIpFrom } from "./auth-activity";
import { isAllowedEmail } from "./branding";
import { db } from "./db";
import {
  accounts,
  jwks,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  passkeys,
  sessions,
  twoFactors,
  users,
  verifications,
} from "./db/schema";
import { sendResetPasswordEmail } from "./email/send";
import { MICROSOFT_AUTH_ENABLED } from "./env";
import { bootBrandName } from "./instance-branding";
import { fetchClientMetadataSafely } from "./mcp/cimd-fetch";
import {
  isMcpEnabled,
  MCP_CONSENT_PATH,
  MCP_RESOURCE,
  MCP_SCOPES,
} from "./mcp/config";
import { recordGrantApproved } from "./mcp/grants";
import { nameTaken, pickFreeName } from "./people/names";
import { orgAc, orgRoles } from "./permissions";
import {
  isStrongSignIn,
  STRONG_SIGN_IN_CODE,
  STRONG_SIGN_IN_MESSAGE,
  signInMethodFor,
  signInMethodForRotation,
} from "./sign-in-method";
import { uuidSchema } from "./validation";

const RESET_PASSWORD_TOKEN_TTL_SECONDS = 60 * 60;

export { ALLOWED_EMAIL_DOMAIN, isAllowedEmail } from "./branding";
// Re-exported so the sign-in page keeps importing it from here; the flag and
// the "all three or none" rule that protects it now live in lib/env, which
// checks them at boot alongside every other var (see validateEnv).
export { MICROSOFT_AUTH_ENABLED } from "./env";
export type { OrgRole } from "./permissions";

const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

// WebAuthn pins every credential to one Relying Party ID and one origin, and
// the browser refuses a ceremony whose rpID is not a registrable suffix of the
// page it runs on. Both are derived from BETTER_AUTH_URL instead of being
// separate env vars: an extra knob can only drift from the URL the app is
// actually served on, and the failure is quiet — registration succeeds and the
// credential is then never offered at sign-in.
const { hostname: RP_ID, origin: RP_ORIGIN } = new URL(BASE_URL);

const microsoftClientId = process.env.MICROSOFT_CLIENT_ID;
const microsoftClientSecret = process.env.MICROSOFT_CLIENT_SECRET;
const microsoftTenantId = process.env.MICROSOFT_TENANT_ID;

// `bun run dev` serves the SPA from Vite on its own port and proxies /api to
// this server, so the browser's requests carry Vite's Origin rather than
// BETTER_AUTH_URL's, and better-auth would refuse them. Development only: in
// production the same server serves the SPA, and the origin is BASE_URL.
const DEV_ORIGINS =
  process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"];

// The instance name as primed at boot (server/index.ts primes the branding
// before this module loads). better-auth fixes appName, the TOTP issuer and
// the passkey rpName at init, so a rename reaches these three after a restart.
const INSTANCE_NAME = bootBrandName();

// The tables better-auth writes, keyed the way the drizzle adapter looks a
// model up with usePlural: the model name plus "s". The jwt plugin's model is
// already named "jwks", so its key is "jwkss" (the table is still `jwks`).
export const authSchema = {
  users,
  sessions,
  accounts,
  verifications,
  passkeys,
  twoFactors,
  jwkss: jwks,
  oauthClients,
  oauthResources,
  oauthClientResources,
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthConsents,
  oauthClientAssertions,
};

export const auth = betterAuth({
  appName: INSTANCE_NAME,
  baseURL: BASE_URL,
  trustedOrigins: DEV_ORIGINS,
  secret: process.env.BETTER_AUTH_SECRET,
  // The jwt plugin's own /token mints a JWT for any signed-in session; MCP
  // access tokens come only from /oauth2/token. The oauth-provider's
  // consent-management endpoints are closed too: grants are listed and
  // revoked by lib/mcp/grants, which also revokes the tokens and logs it,
  // and the consent page reads its request from server/routes/oauth-consent.
  disabledPaths: [
    "/token",
    "/oauth2/get-consent",
    "/oauth2/get-consents",
    "/oauth2/update-consent",
    "/oauth2/delete-consent",
  ],
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema: authSchema,
  }),
  emailAndPassword: {
    enabled: true,
    // No public sign-up — users are created only via invitation.
    disableSignUp: true,
    autoSignIn: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_TTL_SECONDS,
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail(user.email, {
        recipientName: user.name || user.email,
        resetUrl: url,
        expiresInMinutes: Math.round(RESET_PASSWORD_TOKEN_TTL_SECONDS / 60),
      });
    },
  },
  socialProviders: MICROSOFT_AUTH_ENABLED
    ? {
        microsoft: {
          clientId: microsoftClientId as string,
          clientSecret: microsoftClientSecret as string,
          tenantId: microsoftTenantId as string,
          // Unlike email/password, Microsoft sign-in DOES provision users:
          // whoever Entra lets through gets an account on first sign-in. The
          // access decision lives in Entra ("User assignment required" plus a
          // group), so we don't maintain a second list of who may enter.
          //
          // Two things keep that from being a hole:
          //   - the `databaseHooks` guard below rejects any email outside
          //     ALLOWED_EMAIL_DOMAIN, and
          //   - new users land on `defaultRole` (staff): reading the
          //     knowledge base and no project until an admin assigns a job
          //     role, never with ops rights.
          // Invitations still exist for anyone who needs a higher role up front.
          disableSignUp: false,
          // Entra hands back a Graph photo URL that needs a bearer token, so
          // better-auth can't store a usable `image`. lib/avatars-microsoft
          // copies the photo into our own store after sign-in instead.
          disableProfilePhoto: true,
          // Don't silently reuse whatever account the browser is already
          // signed into on login.microsoftonline.com.
          prompt: "select_account",
        },
      }
    : undefined,
  user: {
    // Profile fields ride on the session (the layout needs timezone and
    // status on every render) but are written only by actions/profile.ts,
    // never through /update-user, hence input: false.
    additionalFields: {
      title: { type: "string", required: false, input: false },
      preferredName: { type: "string", required: false, input: false },
      bio: { type: "string", required: false, input: false },
      timezone: { type: "string", required: false, input: false },
      workingHours: { type: "json", required: false, input: false },
      statusEmoji: { type: "string", required: false, input: false },
      statusText: { type: "string", required: false, input: false },
      statusExpiresAt: { type: "date", required: false, input: false },
      avatarSource: { type: "string", required: false, input: false },
      accentColor: { type: "string", required: false, input: false },
      motif: { type: "string", required: false, input: false },
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      // Entra doesn't emit `email_verified` unless the optional claim is
      // configured in the app registration, so without this a first Microsoft
      // sign-in by an existing user fails with `account_not_linked`. Trusting
      // it is safe here only because `tenantId` pins sign-in to our own
      // directory, which owns the addresses it asserts.
      trustedProviders: ["microsoft"],
      // A Microsoft identity may only attach to the user with the same email.
      allowDifferentEmails: false,
    },
  },
  session: {
    additionalFields: {
      signInMethod: { type: "string", required: false, input: false },
    },
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  // Throttle client-initiated auth requests to blunt brute-force and token
  // enumeration. Server-side `auth.api` calls are exempt. Storage is in-memory
  // (the app runs as a single standalone instance); switch to the database
  // adapter if scaled horizontally so counters are shared across replicas.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-in/social": { window: 60, max: 10 },
      "/forget-password": { window: 60, max: 3 },
      "/request-password-reset": { window: 60, max: 3 },
      "/reset-password": { window: 60, max: 5 },
      // A passkey ceremony is two requests (challenge, then verification) and
      // users retry after a cancelled prompt, so these sit above the password
      // limits — they still cap how fast a stolen credential id can be probed.
      "/passkey/generate-authenticate-options": { window: 60, max: 20 },
      "/passkey/verify-authentication": { window: 60, max: 20 },
      "/passkey/generate-register-options": { window: 60, max: 10 },
      "/passkey/verify-registration": { window: 60, max: 10 },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // The OAuth provider exists for MCP agents only, so while an admin has
      // the MCP server switched off its endpoints are absent. The discovery
      // documents never reach this hook: better-auth answers the ones it
      // serves (path-inserted and path-appended) from plugin onRequest
      // handlers, before any hook, and the root authorization server
      // document is built by server/routes/well-known.ts itself. That router,
      // mounted ahead of better-auth for /.well-known and
      // /api/auth/.well-known, applies the same switch to every one of them.
      if (ctx.path.startsWith("/oauth2/") && !(await isMcpEnabled())) {
        throw APIError.from("NOT_FOUND", {
          message: "Not found",
          code: "mcp_disabled",
        });
      }
      // Name and image are written only by actions/profile.ts and
      // lib/avatars, which validate, keep names unique and only ever store
      // our own /api/avatars URL. better-auth's generic user-update endpoints
      // would bypass all of that (`input: false` guards only our additional
      // fields), and nothing in the app calls them, so they are closed.
      if (ctx.path === "/update-user" || ctx.path === "/admin/update-user") {
        throw APIError.from("FORBIDDEN", {
          message: "Profile changes go through the account page.",
          code: "profile_update_forbidden",
        });
      }
      // The admin endpoints (roles, bans, impersonation, session control)
      // need a strong sign-in. With no session the endpoint's own auth answers.
      if (ctx.path.startsWith("/admin/")) {
        const session = await getSessionFromCtx(ctx);
        if (session && !isStrongSignIn(session.session.signInMethod)) {
          throw APIError.from("FORBIDDEN", {
            message: STRONG_SIGN_IN_MESSAGE,
            code: STRONG_SIGN_IN_CODE,
          });
        }
      }
      // Names are unique among active users only, so a deactivated user's
      // name may have been reused since. Reactivating them would trip the
      // unique index with an opaque 500; refuse with a reason instead.
      if (ctx.path === "/admin/unban-user") {
        const parsed = uuidSchema.safeParse(
          (ctx.body as { userId?: unknown } | undefined)?.userId
        );
        // Malformed ids are left to the endpoint's own validation.
        if (!parsed.success) return;
        const userId = parsed.data;
        const [target] = await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (target && (await nameTaken(target.name, userId))) {
          throw APIError.from("CONFLICT", {
            message:
              "Another active user has this name. Rename one of them first.",
            code: "name_taken",
          });
        }
      }
    }),
    // After a request: record sign-ins, failed sign-ins and two-factor changes
    // in the activity log (lib/auth-activity decides what is logged), and after
    // a Microsoft sign-in pull the M365 photo in the background. Both are
    // fire-and-forget: not awaited, so sign-in never waits on them, and a
    // failure only logs. Dynamic import: lib/avatars-microsoft imports this
    // module.
    after: createAuthMiddleware(async (ctx) => {
      // Building the row must never fail the auth response.
      try {
        const returned = ctx.context.returned;
        const row = authActivityFor({
          path: ctx.path,
          params: ctx.params,
          body: ctx.body,
          newSession: ctx.context.newSession,
          session: ctx.context.session,
          error: isAPIError(returned)
            ? { status: returned.statusCode, code: returned.body?.code }
            : null,
          ip: clientIpFrom(ctx.request?.headers),
          userAgent: ctx.request?.headers.get("user-agent") ?? null,
        });
        if (row) void recordActivity(row);
      } catch (error) {
        console.error("Auth activity logging failed:", error);
      }

      // An approved MCP grant: better-auth stored the consent row, and its
      // consent step has no callback of its own. A denial or a refusal is
      // not logged.
      if (
        ctx.path === "/oauth2/consent" &&
        !isAPIError(ctx.context.returned) &&
        (ctx.body as { accept?: unknown } | undefined)?.accept === true
      ) {
        try {
          const oauthQuery = (ctx.body as { oauth_query?: unknown })
            .oauth_query;
          const userId =
            ctx.context.session?.user.id ??
            (await getSessionFromCtx(ctx))?.user.id;
          if (userId && typeof oauthQuery === "string") {
            void recordGrantApproved(userId, oauthQuery);
          }
        } catch (error) {
          console.error("MCP grant logging failed:", error);
        }
      }

      if (!ctx.path.startsWith("/callback") || ctx.params?.id !== "microsoft")
        return;
      const userId = ctx.context.newSession?.user.id;
      if (!userId) return;
      void import("@/lib/avatars-microsoft")
        .then(({ importMicrosoftAvatar }) => importMicrosoftAvatar(userId))
        .catch((error) =>
          console.error("Microsoft avatar import failed:", error)
        );
    }),
  },
  databaseHooks: {
    session: {
      create: {
        // Record how this session was established. A password change that
        // revokes other sessions mints a new one, which inherits the current
        // session's method instead of resetting it. So do the two-factor
        // endpoints that rotate a signed-in session (see
        // signInMethodForRotation).
        before: async (session, ctx) => {
          const path = ctx?.path ?? "";
          const previous = ctx?.context.session?.session.signInMethod ?? null;
          const signInMethod =
            path === "/change-password"
              ? previous
              : ((ctx?.context.session
                  ? signInMethodForRotation(path, previous)
                  : undefined) ?? signInMethodFor(path, ctx?.params));
          return { data: { ...session, signInMethod } };
        },
      },
    },
    user: {
      create: {
        // Last line of defence on who may exist at all. Runs for every user
        // creation path — /setup, invitation acceptance, and Microsoft
        // sign-in — so an Entra identity outside our email domain (a B2B
        // guest, or a second verified domain in the tenant) can never be
        // provisioned even if the Azure-side app assignment is misconfigured.
        //
        // Throwing (rather than returning false) is deliberate: better-auth
        // passes an APIError's `code` through verbatim as the `?error=` value
        // on the OAuth callback redirect, so the sign-in page can explain what
        // happened instead of showing a generic "unable to create user". The
        // code is therefore the lowercase slug sign-in-form.tsx matches on.
        before: async (user) => {
          if (!isAllowedEmail(user.email)) {
            throw APIError.from("FORBIDDEN", {
              message: "domain not allowed",
              code: "domain_not_allowed",
            });
          }
          // A clashing display name must never block a sign-in or an invite.
          return {
            data: { ...user, name: await pickFreeName(user.name, user.email) },
          };
        },
      },
    },
  },
  // Generate UUIDv7 for user/session/account/verification IDs so they are
  // time-ordered and friendly to B-tree indexes (matches our own tables).
  advanced: {
    database: {
      generateId: () => Bun.randomUUIDv7(),
    },
  },
  plugins: [
    admin({
      // Roles and their statements live in lib/permissions. A user nobody
      // assigned a role to — in practice a fresh Microsoft sign-in — lands on
      // `staff`: reading the knowledge base, no project, until an admin
      // assigns a job role.
      ac: orgAc,
      roles: orgRoles,
      defaultRole: "staff",
      adminRoles: ["admin"],
    }),
    // Passkeys are an additional factor a user enrols from their account page —
    // never a sign-up path. Registration keeps the plugin's default of
    // requiring a session, so a passkey can only ever attach to a user who
    // already exists, and the domain and ban rules above therefore still hold:
    // the admin plugin's `session.create` hook rejects a banned user on the
    // passkey sign-in path exactly as it does on the password one.
    // TOTP as a second factor after the password. The issuer is what
    // authenticator apps show next to the account.
    twoFactor({ issuer: INSTANCE_NAME }),
    passkey({
      rpID: RP_ID,
      rpName: INSTANCE_NAME,
      origin: RP_ORIGIN,
      // Discoverable credentials, so sign-in works without typing an email
      // first — that is the whole point of the passkey button on /sign-in.
      // "preferred", not "required", so a security key with no room left for a
      // resident credential can still be enrolled as a second device.
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    }),
    // Menara as the OAuth 2.1 authorization server for MCP agents (spec
    // 2026-07-28). jwt signs the access tokens (RFC 9068, aud = the MCP
    // resource) and serves /jwks; its session-JWT header is off.
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource: MCP_RESOURCE,
      loginPage: "/sign-in",
      consentPage: MCP_CONSENT_PATH,
      scopes: ["offline_access", ...MCP_SCOPES],
      // Rotated refresh tokens are single-use: replaying a spent one deletes
      // its whole refresh-token family (and the access tokens minted from
      // it). The grant (consent) stays; revoking it is lib/mcp/grants' job.
      refreshTokenReuseInterval: 0,
      accessTokenExpiresIn: 3600,
      // An agent acts for the user who approved it; no machine-to-machine
      // client_credentials tokens.
      grantTypes: ["authorization_code", "refresh_token"],
      // Agents register only through their client metadata document (cimd
      // below). No signed-in user may create, list, change or delete OAuth
      // clients through /oauth2/*-client; the plugin's default lets any
      // session do so.
      clientPrivileges: () => false,
      // DPoP is not offered. better-auth records each proof's jti in
      // `verifications` under a base64url id, which our uuid id column
      // refuses (a 500). With no accepted algorithm every DPoP proof is
      // refused as invalid_dpop_proof (400) before that write, and
      // server/routes/well-known.ts drops the then-empty
      // dpop_signing_alg_values_supported from the discovery documents.
      dpop: { signingAlgorithms: [] },
    }),
    cimd({
      fetchClientMetadataResource: fetchClientMetadataSafely,
      metadataProfile: "mcp-2026-07-28",
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
