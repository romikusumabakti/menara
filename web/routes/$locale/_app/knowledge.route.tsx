import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { CollectionCreateDialog } from "@/components/collection-create-dialog";
import {
  KnowledgeSearchProvider,
  KnowledgeSearchTrigger,
} from "@/components/knowledge-search";
import { KnowledgeTree } from "@/components/knowledge-tree";
import { Button } from "@/components/ui/button";
import { WorkspaceLayout } from "@/components/workspace-layout";
import { Link, usePathname } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { listCollectionsQuery, listTreeNodesQuery } from "@/web/api/knowledge";
import { useMe } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

// The knowledge area (the port of `knowledge/layout.tsx`): a tree sidebar and
// the document pages in `<Outlet />`. Each child brings its own pending
// skeleton, so the sidebar stays put while a document loads.
export const Route = createFileRoute("/$locale/_app/knowledge")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { knowledge: ["read"] }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listCollectionsQuery()),
      loaderQuery(queryClient, listTreeNodesQuery()),
    ]);
  },
  component: KnowledgeLayout,
});

function KnowledgeLayout() {
  const t = useTranslations("knowledge");
  const me = useMe();
  const canManage = canOrg(me?.orgRole, { knowledge: ["manage"] });
  const collections = useSuspenseQuery(listCollectionsQuery()).data;
  const nodes = useSuspenseQuery(listTreeNodesQuery()).data;
  const canWrite = canOrg(me?.orgRole, { knowledge: ["write"] });
  // "New document" files under the collection of the document being read.
  const openSlug = usePathname().match(/\/knowledge\/([a-z0-9-]+)/)?.[1];
  const openCollectionId = nodes.find((n) => n.slug === openSlug)?.collectionId;

  return (
    <KnowledgeSearchProvider>
      <WorkspaceLayout
        sidebar={
          <>
            <div className="flex flex-col gap-3 px-3 py-4 lg:shrink-0">
              {collections.length > 0 && canWrite && (
                <Button
                  nativeButton={false}
                  render={
                    <Link
                      href={
                        openCollectionId
                          ? `/knowledge/new?collection=${openCollectionId}`
                          : "/knowledge/new"
                      }
                    />
                  }
                  size="sm"
                  variant="outline"
                >
                  <Plus className="size-4" />
                  {t("newDocument")}
                </Button>
              )}
              {collections.length > 0 && (
                <KnowledgeSearchTrigger variant="sidebar" />
              )}
              <div className="flex items-center justify-between gap-2 px-2">
                <h2 className="font-medium text-muted-foreground text-xs">
                  {t("collectionsHeading")}
                </h2>
                {canManage && <CollectionCreateDialog />}
              </div>
            </div>
            <div
              data-scroll-shadow
              className="px-2 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
            >
              <KnowledgeTree
                collections={collections}
                nodes={nodes}
                canManage={canManage}
                canWrite={canWrite}
              />
            </div>
          </>
        }
      >
        <Outlet />
      </WorkspaceLayout>
    </KnowledgeSearchProvider>
  );
}
