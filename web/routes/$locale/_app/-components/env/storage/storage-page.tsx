import { useSuspenseQuery } from "@tanstack/react-query";
import { HardDrive, Lock } from "lucide-react";
import { useTranslations } from "use-intl";
import { FileExplorer } from "@/components/file-explorer";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Link } from "@/i18n/navigation";
import { environmentStorageQuery } from "@/web/api/environment-storage";
import { useCanOrg } from "@/web/api/session";

/**
 * An environment's Storage page: the file explorer on its one bucket (and key
 * prefix), or a not-configured state that links to Settings › Storage for
 * whoever can change it. A storage that holds the instance backups is
 * restricted to the org roles with storage files (the server refuses the
 * rest), so everyone else sees a notice instead of a failing explorer.
 */
export function StorageExplorerPage({
  environmentId,
  canManage,
  settingsHref,
}: {
  environmentId: string;
  canManage: boolean;
  settingsHref: string;
}) {
  const t = useTranslations("storage");
  const canOrg = useCanOrg();
  const storage = useSuspenseQuery(environmentStorageQuery(environmentId)).data;

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={storage ? t("subtitle", { bucket: storage.bucket }) : undefined}
    />
  );

  if (!storage) {
    return (
      <>
        {header}
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HardDrive />
            </EmptyMedia>
            <EmptyTitle>{t("notConfiguredTitle")}</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? t("notConfiguredDescription")
                : t("notConfiguredReadOnly")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="empty:hidden">
            {canManage ? (
              <Button
                nativeButton={false}
                variant="outline"
                render={<Link href={settingsHref} />}
              >
                {t("openSettings")}
              </Button>
            ) : undefined}
          </EmptyContent>
        </Empty>
      </>
    );
  }

  if (
    storage.isBackupDestination &&
    !canOrg({ storage: ["files"] }, /* restricted */ true)
  ) {
    return (
      <>
        {header}
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock />
            </EmptyMedia>
            <EmptyTitle>{t("restrictedTitle")}</EmptyTitle>
            <EmptyDescription>{t("restrictedDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      {header}
      <FileExplorer
        source={{ kind: "s3", environmentId }}
        rootLabel={storage.bucket}
      />
    </>
  );
}
