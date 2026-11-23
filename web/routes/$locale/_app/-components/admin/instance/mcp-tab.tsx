import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Unplug } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { useDialog } from "@/components/dialog-provider";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/web/api/client";
import {
  getInstanceMcpQuery,
  type InstanceMcpData,
  revokeInstanceGrant,
  setInstanceMcpEnabled,
} from "@/web/api/mcp";

type Grant = InstanceMcpData["grants"][number];

/** A refusal's own message, else the generic one. */
function errorToast(error: unknown, fallback: string) {
  toast.error(error instanceof ApiError ? error.message : fallback);
}

/** Drops every MCP query, so the switch and the account tab agree at once. */
function refreshMcp(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: ["mcp"] });
}

/**
 * Admin › Instance › MCP: the instance switch for MCP clients, the URL they
 * connect to, every user's grants with revoke, and the access-proxy paths.
 */
export function McpTab() {
  const { data } = useSuspenseQuery(getInstanceMcpQuery());
  return (
    <div className="flex flex-col gap-6">
      <SettingsCard data={data} />
      <GrantsCard grants={data.grants} />
    </div>
  );
}

function SettingsCard({ data }: { data: InstanceMcpData }) {
  const t = useTranslations("instanceMcp");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: setInstanceMcpEnabled,
    onSuccess: ({ enabled }) =>
      toast.success(enabled ? t("turnedOn") : t("turnedOff")),
    onError: (error) => errorToast(error, tCommon("errorGeneric")),
    onSettled: () => refreshMcp(queryClient),
  });
  // Shows the requested state while the request is out.
  const checked = toggle.isPending ? toggle.variables : data.enabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex max-w-2xl flex-col gap-6">
        <FieldGroup>
          <Field orientation="horizontal">
            <Switch
              id="instance-mcp-enabled"
              checked={checked}
              disabled={toggle.isPending}
              onCheckedChange={(next) => toggle.mutate(next)}
            />
            <FieldContent>
              <FieldLabel
                htmlFor="instance-mcp-enabled"
                className="font-normal"
              >
                {t("enabled")}
              </FieldLabel>
              <FieldDescription>{t("enabledDescription")}</FieldDescription>
            </FieldContent>
          </Field>
          <Field>
            <FieldLabel>{t("resourceUrl")}</FieldLabel>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2">
              <code className="min-w-0 font-mono text-sm break-all">
                {data.resourceUrl}
              </code>
              <CopyButton value={data.resourceUrl} />
            </div>
          </Field>
        </FieldGroup>
        <Alert>
          <AlertTitle>{t("proxyTitle")}</AlertTitle>
          <AlertDescription>{t("proxyNote")}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function GrantsCard({ grants }: { grants: Grant[] }) {
  const t = useTranslations("instanceMcp");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (grant: Grant) =>
      revokeInstanceGrant(grant.userId, grant.clientId),
    onSuccess: () => toast.success(t("revoked")),
    onError: (error) => errorToast(error, tCommon("errorGeneric")),
    onSettled: () => refreshMcp(queryClient),
  });

  async function onRevoke(grant: Grant) {
    const ok = await dialog.confirm({
      title: t("revokeTitle", { client: grant.clientName }),
      description: t("revokeDescription", { user: grant.userName }),
      confirmText: t("revoke"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (ok) revoke.mutate(grant);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("grantsTitle")}</CardTitle>
        <CardDescription>{t("grantsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("grantsEmpty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("user")}</TableHead>
                <TableHead>{t("client")}</TableHead>
                <TableHead>{t("scopes")}</TableHead>
                <TableHead>{t("lastUsed")}</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((grant) => (
                <TableRow key={`${grant.userId} ${grant.clientId}`}>
                  <TableCell className="font-medium">
                    {grant.userName}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{grant.clientName}</span>
                      {grant.clientHost && (
                        <span className="text-xs text-muted-foreground">
                          {grant.clientHost}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {grant.scopes.map((scope) => (
                        <Badge
                          key={scope}
                          variant="outline"
                          className="font-mono"
                        >
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {grant.lastUsedAt ? (
                      <RelativeTime date={grant.lastUsedAt} />
                    ) : (
                      t("never")
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRevoke(grant)}
                      disabled={
                        revoke.isPending &&
                        revoke.variables?.userId === grant.userId &&
                        revoke.variables.clientId === grant.clientId
                      }
                    >
                      <Unplug data-icon="inline-start" />
                      {t("revoke")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
