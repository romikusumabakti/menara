import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { legacyStorageConnectionHref } from "./-components/storage-redirect";

// An old file-browser link goes to its environment's Storage page, which is
// the explorer.
export const Route = createFileRoute("/$locale/_app/storage/$id/files")({
  beforeLoad: async ({ params: { locale, id }, context: { queryClient } }) =>
    redirect(await legacyStorageConnectionHref(queryClient, id), locale),
});
