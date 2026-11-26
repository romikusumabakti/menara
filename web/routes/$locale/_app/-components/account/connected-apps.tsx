import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { useDialog } from "@/components/dialog-provider";
import { useRelativeTimeText } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Link } from "@/i18n/navigation";
import {
  type McpClientSetup,
  mcpClientSetups,
  mcpServerName,
} from "@/lib/mcp/client-setup";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import {
  getMcpSetupQuery,
  listConnectedAppsQuery,
  type McpGrantRow,
  revokeConnectedApp,
} from "@/web/api/mcp";
import { useBootstrap, useMe } from "@/web/api/session";

type T = ReturnType<typeof useTranslations<"connectedApps">>;

function Pending() {
  return (
    <div className="flex items-center justify-center py-10 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

/**
 * Account › Connected apps: the agents the user allowed to use their account
 * over MCP, with revoke, and how to connect one. While an admin has MCP off
 * it is one line (plus, for admins, the way to the switch).
 */
export function ConnectedApps() {
  const t = useTranslations("connectedApps");
  const me = useMe();
  const setup = useQuery(getMcpSetupQuery());

  if (setup.isPending) return <Pending />;
  if (!setup.data?.enabled) {
    const canManage = canOrg(me?.orgRole, { instance: ["manage"] });
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t("disabled")}</span>
          {canManage && (
            <Link
              href="/admin/instance?tab=mcp"
              className="font-medium underline-offset-4 hover:underline"
            >
              {t("disabledAdminLink")}
            </Link>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <GrantsList />
        </CardContent>
      </Card>
      <SetupCard url={setup.data.resourceUrl} />
    </>
  );
}

function GrantsList() {
  const t = useTranslations("connectedApps");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const grants = useQuery(listConnectedAppsQuery());
  const revoke = useMutation({
    mutationFn: revokeConnectedApp,
    onSuccess: () => toast.success(t("revoked")),
    onError: (error) =>
      toast.error(
        error instanceof ApiError ? error.message : tCommon("errorGeneric")
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["mcp", "listConnectedApps"] }),
  });

  async function onRevoke(grant: McpGrantRow) {
    const ok = await dialog.confirm({
      title: t("revokeTitle", { client: grant.clientName }),
      description: t("revokeDescription"),
      confirmText: t("revoke"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (ok) revoke.mutate(grant.clientId);
  }

  if (grants.isPending) return <Pending />;
  const rows = grants.data ?? [];
  if (rows.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul className="divide-y">
      {rows.map((grant) => (
        <li
          key={grant.clientId}
          className="flex items-center justify-between gap-4 py-3"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
              <Bot className="size-4 text-muted-foreground" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate font-medium">{grant.clientName}</span>
                {grant.clientHost && (
                  <span className="truncate text-xs text-muted-foreground">
                    {grant.clientHost}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {grant.scopes.map((scope) => (
                  <Badge key={scope} variant="outline" className="font-mono">
                    {scope}
                  </Badge>
                ))}
              </div>
              <GrantTimes t={t} grant={grant} />
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => onRevoke(grant)}
            disabled={revoke.isPending && revoke.variables === grant.clientId}
          >
            <Unplug data-icon="inline-start" />
            {t("revoke")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function GrantTimes({ t, grant }: { t: T; grant: McpGrantRow }) {
  const relative = useRelativeTimeText();
  return (
    <div className="text-xs text-muted-foreground">
      {t("approved", { time: relative(grant.approvedAt) })}
      {" · "}
      {grant.lastUsedAt
        ? t("lastUsed", { time: relative(grant.lastUsedAt) })
        : t("lastUsedNever")}
    </div>
  );
}

function SetupCard({ url }: { url: string }) {
  const t = useTranslations("connectedApps");
  const { appName } = useBootstrap();
  const name = mcpServerName(appName);
  const setups = mcpClientSetups(name, url);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("setupTitle")}</CardTitle>
        <CardDescription>{t("setupDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t("serverUrl")}</span>
          <Snippet value={url} />
        </div>
        {setups.map((setup) => (
          <SetupSteps key={setup.id} t={t} setup={setup} name={name} />
        ))}
      </CardContent>
    </Card>
  );
}

/** One client's numbered steps, each with its snippet to copy. */
function SetupSteps({
  t,
  setup,
  name,
}: {
  t: T;
  setup: McpClientSetup;
  name: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{setup.label}</h3>
      <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm marker:text-muted-foreground">
        {setup.steps.map((step) => (
          <li key={step.text} className="ps-1">
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground">
                {t(`steps.${step.text}`, { name })}
              </span>
              {step.snippet && <Snippet value={step.snippet} />}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A copyable code block. */
function Snippet({ value }: { value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-lg bg-muted px-3 py-2">
      <pre className="min-w-0 overflow-x-auto font-mono text-sm whitespace-pre-wrap break-all">
        {value}
      </pre>
      <CopyButton value={value} />
    </div>
  );
}
