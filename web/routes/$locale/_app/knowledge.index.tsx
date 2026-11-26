import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, FileText, Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { KnowledgeSearchTrigger } from "@/components/knowledge-search";
import { RelativeTime } from "@/components/relative-time";
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
import {
  listCollectionsQuery,
  recentKnowledgeQuery,
} from "@/web/api/knowledge";
import { useMe } from "@/web/api/session";
import { loaderQuery } from "@/web/query-client";
import { KnowledgeLandingPending } from "./-components/knowledge/knowledge-landing-pending";

export const Route = createFileRoute("/$locale/_app/knowledge/")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listCollectionsQuery()),
      loaderQuery(queryClient, recentKnowledgeQuery()),
    ]);
  },
  pendingComponent: KnowledgeLandingPending,
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
    // WorkspaceLayout's main neither scrolls nor pads, so the page does both.
    <div className="h-full overflow-y-auto px-4 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-6 pt-10 pb-[12vh]">
        <div className="flex flex-col gap-4 text-center">
          <h1 className="font-semibold text-2xl tracking-tight">
            {t("landingTitle")}
          </h1>
          <KnowledgeSearchTrigger variant="hero" />
        </div>
        <RecentlyUpdated canWrite={canWrite} />
      </div>
    </div>
  );
}

function RecentlyUpdated({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations("knowledge");
  const { items } = useSuspenseQuery(recentKnowledgeQuery()).data;

  if (items.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpen />
          </EmptyMedia>
          <EmptyDescription>{t("recentEmptyHint")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="empty:hidden">
          {canWrite ? (
            <Button
              nativeButton={false}
              render={<Link href="/knowledge/new" />}
            >
              <Plus className="size-4" />
              {t("newDocument")}
            </Button>
          ) : undefined}
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("recentTitle")}
      </h2>
      <ul className="flex flex-col">
        {items.map((item) => (
          <li key={item.slug}>
            <Link
              href={`/knowledge/${item.slug}`}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-sm">
                  {item.title}
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  {item.collection.name}
                  {item.editedBy ? ` · ${item.editedBy.name}` : ""}
                  {" · "}
                  <RelativeTime date={item.editedAt} />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
