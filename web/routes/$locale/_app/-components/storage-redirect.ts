import type { QueryClient } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { ApiError } from "@/web/api/client";
import { s3ConnectionLocationQuery } from "@/web/api/s3-connections";

// Where the removed global Storage URLs (/storage, /storage/new,
// /storage/<id>, /storage/<id>/files) now lead. Storage belongs to an
// environment, so a connection URL resolves to its environment's Storage page
// (the server answers only for environments the caller may view) and
// everything else is a 404.

/** The list and create URLs: the projects page, where environments are found. */
export const LEGACY_STORAGE_INDEX_HREF = "/projects";

/** A connection URL, with or without `/files`: its environment's Storage page. */
export async function legacyStorageConnectionHref(
  queryClient: QueryClient,
  id: string
): Promise<string> {
  const location = await queryClient
    .query(s3ConnectionLocationQuery(id))
    .catch((error: unknown) => {
      // A malformed id, or a connection the caller can't reach.
      if (error instanceof ApiError && [400, 403, 404].includes(error.status)) {
        throw notFound();
      }
      throw error;
    });
  return `/${location.projectKey}/${location.envSlug}/storage`;
}
