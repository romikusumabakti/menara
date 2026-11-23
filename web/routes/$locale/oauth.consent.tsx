import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { useTranslations } from "use-intl";
import { AuthShell } from "@/components/auth-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  type SearchRecord,
  signedOAuthParams,
  toQueryString,
} from "@/lib/mcp/oauth-query";
import { ApiError } from "@/web/api/client";
import { consentInfoQuery } from "@/web/api/oauth";
import { PendingScreen } from "@/web/components/pending-screen";
import { ConsentCard, ConsentTitle } from "./-components/oauth/consent-card";

// Where better-auth sends the browser to approve an MCP agent
// (MCP_CONSENT_PATH, `/oauth/consent?<signed authorize query>`; the server
// adds the locale). Beside `_app`, so no app shell: it is framed like the
// sign-in page. Signed out, the $locale gate sends the visitor to sign-in and
// back here with the query intact.
export const Route = createFileRoute("/$locale/oauth/consent")({
  // Only the signed OAuth parameters: they are what the page verifies and
  // what better-auth's client plugin sends back from the URL.
  validateSearch: (search: Record<string, unknown>): SearchRecord =>
    signedOAuthParams(search) ?? {},
  component: ConsentPage,
});

function ConsentPage() {
  const search = Route.useSearch();
  const signed = signedOAuthParams(search);
  if (!signed) return <ConsentError />;
  return <Consent signed={signed} />;
}

function Consent({ signed }: { signed: SearchRecord }) {
  const { data, error, isPending } = useQuery(consentInfoQuery(signed));
  if (isPending) return <PendingScreen />;
  if (error || !data) return <ConsentError error={error} />;
  return (
    <AuthShell title={<ConsentTitle info={data} />}>
      <ConsentCard info={data} oauthQuery={toQueryString(signed)} />
    </AuthShell>
  );
}

function ConsentError({ error }: { error?: unknown }) {
  const t = useTranslations("oauthConsent");
  const tErrors = useTranslations("actionErrors");
  const coded =
    error instanceof ApiError && error.code === "oauthConsentInvalid";
  const message =
    !error || coded
      ? tErrors("oauthConsentInvalid")
      : error instanceof Error
        ? error.message
        : t("failed");
  return (
    <AuthShell title={t("errorTitle")}>
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </AuthShell>
  );
}
