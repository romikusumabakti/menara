import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { LEGACY_STORAGE_INDEX_HREF } from "./-components/storage-redirect";

// Storage is configured in its environment's settings; see storage.index.tsx.
export const Route = createFileRoute("/$locale/_app/storage/new")({
  beforeLoad: ({ params: { locale } }) =>
    redirect(LEGACY_STORAGE_INDEX_HREF, locale),
});
