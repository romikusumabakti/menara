import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

/** The Menara release this instance runs (About Menara). */
export async function getAbout() {
  return parseResponse(api.api.about.$get());
}

export const getAboutQuery = () =>
  queryOptions({
    queryKey: ["about"],
    queryFn: getAbout,
    // Fixed per image: a new version means a restart and a page reload.
    staleTime: Number.POSITIVE_INFINITY,
  });
