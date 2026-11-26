import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Bookmarks of a connection's file browser: the environment's Storage page is
// the explorer.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/storage/$connectionId/files"
)({
  beforeLoad: ({ params: { locale, projectKey, envSlug } }) =>
    redirect(`/${projectKey}/${envSlug}/storage`, locale),
});
