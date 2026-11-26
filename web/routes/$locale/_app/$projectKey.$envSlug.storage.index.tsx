import { createFileRoute } from "@tanstack/react-router";
import { FileExplorerSkeleton } from "@/components/skeletons/file-explorer-skeleton";
import { SECTION_PERMS } from "@/lib/nav-path";
import { canProject } from "@/lib/permissions";
import { environmentStorageQuery } from "@/web/api/environment-storage";
import { requireRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { StorageExplorerPage } from "./-components/env/storage/storage-page";

// The environment's Storage page is its file explorer. Reading objects takes
// the variable-read right (the server checks it on every explorer request).
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/storage/"
)({
  beforeLoad: ({ context: { role } }) =>
    requireRole(role, SECTION_PERMS.storage),
  loader: async ({ context: { queryClient, environmentId } }) => {
    await loaderQuery(queryClient, environmentStorageQuery(environmentId));
  },
  pendingComponent: FileExplorerSkeleton,
  component: StoragePage,
});

function StoragePage() {
  const { projectKey, envSlug } = Route.useParams();
  const { environmentId, role } = Route.useRouteContext();
  return (
    <StorageExplorerPage
      environmentId={environmentId}
      canManage={canProject(role, SECTION_PERMS.settings)}
      settingsHref={`/${projectKey}/${envSlug}/settings?tab=storage`}
    />
  );
}
