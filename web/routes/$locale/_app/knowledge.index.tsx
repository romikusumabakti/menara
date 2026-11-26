import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, Plus } from "lucide-react";
import { useTranslations } from "use-intl";
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
import { canOrg } from "@/lib/permissions";
import { listCollectionsQuery } from "@/web/api/knowledge";
import { useMe } from "@/web/api/session";
import { loaderQuery } from "@/web/query-client";

export const Route = createFileRoute("/$locale/_app/knowledge/")({
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listCollectionsQuery());
  },
  component: KnowledgeHome,
});

function KnowledgeHome() {
  const t = useTranslations("knowledge");
  const me = useMe();
  const canWrite = canOrg(me?.orgRole, { knowledge: ["write"] });
  const collections = useSuspenseQuery(listCollectionsQuery()).data;

  if (collections.length === 0) {
    return (
      <Empty className="h-full border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpen />
          </EmptyMedia>
          <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("emptyAdminHint")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Empty className="h-full border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpen />
        </EmptyMedia>
        <EmptyTitle>{t("landingTitle")}</EmptyTitle>
        <EmptyDescription>{t("landingHint")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="empty:hidden">
        {canWrite ? (
          <Button nativeButton={false} render={<Link href="/knowledge/new" />}>
            <Plus className="size-4" />
            {t("newDocument")}
          </Button>
        ) : undefined}
      </EmptyContent>
    </Empty>
  );
}
