import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { LEGACY_STORAGE_INDEX_HREF } from "./-components/storage-redirect";

// The global Storage page is gone: storage belongs to an environment. Old
// links land on the projects page.
export const Route = createFileRoute("/$locale/_app/storage/")({
  beforeLoad: ({ params: { locale } }) =>
    redirect(LEGACY_STORAGE_INDEX_HREF, locale),
});
