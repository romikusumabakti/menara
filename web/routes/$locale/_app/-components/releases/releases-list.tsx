import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  Download,
  Loader2,
  PackageCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { PageHeader } from "@/components/page-header";
import { useProjectCan } from "@/components/project-role";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { type RowAction, RowActions } from "@/components/ui/row-actions";
import { UserName } from "@/components/user/user-name";
import { canOrg } from "@/lib/permissions";
import { cn, formatBytes } from "@/lib/utils";
import {
  deleteRelease,
  listProjectReleasesQuery,
  type ReleaseListItem,
  releaseDownloadHref,
} from "@/web/api/releases";
import { useMe } from "@/web/api/session";
import { latestPerComponent, versionStatus } from "./releases-model";

// While a release is being prepared, poll so it turns Ready without a reload.
const PREPARING_POLL_MS = 5000;

/** Releases grouped by version, the group of the newest release first. */
function groupByVersion(releases: ReleaseListItem[]) {
  const groups = new Map<string, ReleaseListItem[]>();
  for (const release of releases) {
    const group = groups.get(release.version);
    if (group) group.push(release);
    else groups.set(release.version, [release]);
  }
  return [...groups];
}

/**
 * A project's releases as a list of versions, each a card of compact component
 * rows. Download needs the engineer role and a ready release; delete is for
 * org admins. The API enforces the same.
 */
export function ReleasesList({ projectId }: { projectId: string }) {
  const t = useTranslations("releases");
  const { releases, totalBytes } = useSuspenseQuery({
    ...listProjectReleasesQuery(projectId),
    refetchInterval: (query) =>
      query.state.data?.releases.some((r) => r.status === "preparing")
        ? PREPARING_POLL_MS
        : false,
  }).data;
  const canDownload = useProjectCan({ release: ["download"] });
  const canDelete = canOrg(useMe()?.orgRole, { server: ["manage"] });
  const groups = groupByVersion(releases);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <p className="text-sm text-muted-foreground">
            {t("totalSize")}:{" "}
            <span className="font-medium text-foreground">
              {formatBytes(totalBytes)}
            </span>
          </p>
        }
      />
      {groups.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageCheck />
            </EmptyMedia>
            <EmptyTitle>{t("title")}</EmptyTitle>
            <EmptyDescription>{t("empty")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([version, rows]) => (
            <VersionCard
              key={version}
              version={version}
              rows={rows}
              canDownload={canDownload}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}
    </>
  );
}

function VersionCard({
  version,
  rows,
  canDownload,
  canDelete,
}: {
  version: string;
  rows: ReleaseListItem[];
  canDownload: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("releases");
  const latest = new Set(latestPerComponent(rows).map((r) => r.id));
  // The version was tested on one environment and made by one person: the
  // newest row of the version speaks for it.
  const [first] = [...rows].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono">{version}</span>
          <StatusBadge status={versionStatus(rows)} />
        </CardTitle>
        {first && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>
              {t("testedOn")}{" "}
              <span className="text-foreground">{first.environmentName}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <UserName
                avatar="xs"
                user={
                  first.createdBy && first.createdByName
                    ? {
                        id: first.createdBy,
                        name: first.createdByName,
                        image: null,
                      }
                    : null
                }
              />
              <RelativeTime date={first.createdAt} />
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {rows.map((release) => (
            <ReleaseRow
              key={release.id}
              release={release}
              superseded={!latest.has(release.id)}
              canDownload={canDownload}
              canDelete={canDelete}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ReleaseRow({
  release,
  superseded,
  canDownload,
  canDelete,
}: {
  release: ReleaseListItem;
  superseded: boolean;
  canDownload: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("releases");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const queryClient = useQueryClient();

  async function onCopyTag() {
    try {
      await navigator.clipboard.writeText(release.tag);
      toast.success(tCommon("copied"));
    } catch {
      toast.error(tCommon("copyFailed"));
    }
  }

  async function onDelete() {
    const ok = await dialog.confirm({
      title: t("deleteTitle", { version: release.version }),
      description: t("deleteDescription", { component: release.componentKey }),
      confirmText: t("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteRelease(release.id);
      toast.success(t("deleted"));
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tCommon("errorGeneric")
      );
    }
  }

  const items: RowAction[] = [
    { label: t("copyTag"), icon: Copy, onSelect: onCopyTag },
    ...(canDelete
      ? [
          {
            label: t("delete"),
            icon: Trash2,
            destructive: true,
            onSelect: onDelete,
          },
        ]
      : []),
  ];

  return (
    <li data-slot="release-row" className="flex items-center gap-3 px-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "font-mono text-sm",
              superseded && "text-muted-foreground"
            )}
          >
            {release.componentKey}
          </span>
          {superseded && (
            <span className="sr-only">{t("supersededLabel")}</span>
          )}
          {release.status !== "ready" && (
            <StatusBadge status={release.status} />
          )}
        </div>
        <p
          data-slot="release-source"
          className="truncate font-mono text-xs text-muted-foreground"
          title={`${release.commitSha}\n${release.tag}`}
        >
          {release.branch} · {release.commitSha.slice(0, 7)} · {release.tag}
        </p>
        {release.status === "failed" && release.error && (
          <p className="text-xs text-destructive">{release.error}</p>
        )}
        {release.notes && (
          <p className="max-w-[40rem] whitespace-pre-line text-xs text-muted-foreground">
            {release.notes}
          </p>
        )}
      </div>
      <span className="text-sm text-muted-foreground">
        {release.sizeBytes === null ? "" : formatBytes(release.sizeBytes)}
      </span>
      {canDownload && release.status === "ready" && (
        <Button
          variant="outline"
          size="sm"
          render={<a href={releaseDownloadHref(release.id)} download />}
          nativeButton={false}
        >
          <Download data-icon="inline-start" />
          {t("download")}
        </Button>
      )}
      <RowActions
        label={t("rowActions", {
          component: release.componentKey,
          version: release.version,
        })}
        items={items}
      />
    </li>
  );
}

function StatusBadge({ status }: { status: ReleaseListItem["status"] }) {
  const t = useTranslations("releases");
  const label = t(`status.${status}`);
  switch (status) {
    case "ready":
      return (
        <Badge className="bg-success/15 text-success border-transparent">
          <CheckCircle2 data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <CircleAlert data-icon="inline-start" />
          {label}
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">
          <Loader2 data-icon="inline-start" className="animate-spin" />
          {label}
        </Badge>
      );
  }
}
