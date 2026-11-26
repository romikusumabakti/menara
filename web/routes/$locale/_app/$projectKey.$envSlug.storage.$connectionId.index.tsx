import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Bookmarks of the per-connection page: an environment has one storage now.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/storage/$connectionId/"
)({
  beforeLoad: ({ params: { locale, projectKey, envSlug } }) =>
    redirect(`/${projectKey}/${envSlug}/storage`, locale),
});
