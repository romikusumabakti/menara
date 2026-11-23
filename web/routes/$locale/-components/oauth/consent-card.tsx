import { CircleAlert, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import type { Locale } from "@/i18n/locales";
import { localizeHref } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";
import { MCP_SCOPES, type McpScope } from "@/lib/mcp/scopes";

/** What GET /api/oauth/consent-info answers (server/routes/oauth-consent.ts). */
export type ConsentInfo = {
  client: { name: string | null; host: string | null; logoUrl: null };
  redirectHost: string | null;
  scopes: McpScope[];
  offlineAccess: boolean;
  account: { name: string; email: string };
};

/** The scopes the user may leave out; `read` is part of every grant. */
type OptionalScope = Exclude<McpScope, "read">;

const SCOPE_COPY = {
  read: "scopeRead",
  "database:read": "scopeDatabaseRead",
  "issues:write": "scopeIssuesWrite",
  "deploys:write": "scopeDeploysWrite",
} as const satisfies Record<McpScope, string>;

/**
 * The consent step of an MCP agent's authorization: who is asking, where the
 * answer goes, who is signed in, and one row per requested scope. Allow and
 * Deny answer through better-auth (`oauth2.consent`), whose client plugin
 * adds the signed query from the URL and follows the redirect it returns.
 *
 * `oauthQuery` is that signed query, kept so "Switch account" can carry it
 * to the sign-in page, where signing in resumes this same request.
 */
export function ConsentCard({
  info,
  oauthQuery,
}: {
  info: ConsentInfo;
  oauthQuery: string;
}) {
  const t = useTranslations("oauthConsent");
  const locale = useLocale() as Locale;
  const optional = info.scopes.filter(
    (scope): scope is OptionalScope => scope !== "read"
  );
  const [ticked, setTicked] = useState<ReadonlySet<OptionalScope>>(
    () => new Set(optional)
  );
  const [pending, setPending] = useState<"allow" | "deny" | "switch" | null>(
    null
  );
  const [failed, setFailed] = useState(false);

  async function answer(accept: boolean) {
    setFailed(false);
    setPending(accept ? "allow" : "deny");
    const scope = [
      ...(info.offlineAccess ? ["offline_access"] : []),
      ...MCP_SCOPES.filter(
        (s) => s === "read" || ticked.has(s as OptionalScope)
      ),
    ].join(" ");
    const { error } = await authClient.oauth2.consent(
      accept ? { accept: true, scope } : { accept: false }
    );
    // On success the client plugin is already sending the browser on to the
    // agent's redirect, so the buttons stay busy until the page goes.
    if (error) {
      setPending(null);
      setFailed(true);
    }
  }

  async function switchAccount() {
    setPending("switch");
    await authClient.signOut();
    // A full load: nothing of this session may survive into the next one,
    // and the sign-in page resumes the request from the query it carries.
    window.location.assign(localizeHref(`/sign-in?${oauthQuery}`, locale));
  }

  const busy = pending !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        {info.client.host && (
          <p>{t("clientHost", { host: info.client.host })}</p>
        )}
        {info.redirectHost && (
          <p>{t("redirectHost", { host: info.redirectHost })}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span>
          {t("signedInAs", {
            name: info.account.name,
            email: info.account.email,
          })}
        </span>
        <span className="text-muted-foreground">
          {t("notYou")}{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={switchAccount}
            disabled={busy}
          >
            {t("switchAccount")}
          </Button>
        </span>
      </div>

      <FieldSet>
        <FieldLegend variant="label">{t("scopesHeading")}</FieldLegend>
        <FieldGroup className="gap-4">
          <Field orientation="horizontal" data-scope-row="read">
            <FieldContent>
              <FieldTitle>{t(SCOPE_COPY.read)}</FieldTitle>
              <FieldDescription>{t("alwaysIncluded")}</FieldDescription>
            </FieldContent>
          </Field>
          {optional.map((scope) => {
            const id = `oauth-consent-${scope.replace(":", "-")}`;
            return (
              <Field
                key={scope}
                orientation="horizontal"
                data-scope-row={scope}
              >
                <Checkbox
                  id={id}
                  data-scope={scope}
                  checked={ticked.has(scope)}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setTicked((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(scope);
                      else next.delete(scope);
                      return next;
                    })
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor={id} className="font-normal">
                    {t(SCOPE_COPY[scope])}
                  </FieldLabel>
                  {scope === "database:read" && (
                    <FieldDescription className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                      <TriangleAlert
                        className="mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      {t("scopeDatabaseReadWarning")}
                    </FieldDescription>
                  )}
                </FieldContent>
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>

      <div aria-live="polite" aria-atomic="true" className="empty:hidden">
        {failed && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{t("failed")}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => answer(false)}
            disabled={busy}
            aria-busy={pending === "deny"}
          >
            {pending === "deny" && (
              <Loader2 className="animate-spin" aria-hidden="true" />
            )}
            {t("deny")}
          </Button>
          <Button
            type="button"
            className="flex-1"
            onClick={() => answer(true)}
            disabled={busy}
            aria-busy={pending === "allow"}
          >
            {pending === "allow" && (
              <Loader2 className="animate-spin" aria-hidden="true" />
            )}
            {t("allow")}
          </Button>
        </div>
        <Separator />
        <p className="text-xs text-muted-foreground">{t("footer")}</p>
      </div>
    </div>
  );
}

/**
 * The page title, which names the client: its registered name, else the host
 * its client_id lives at.
 */
export function ConsentTitle({ info }: { info: ConsentInfo }) {
  const t = useTranslations("oauthConsent");
  return t("title", { client: info.client.name ?? info.client.host ?? "" });
}
