import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api["s3-connections"];

/**
 * Where an old /storage/<id> link leads: the connection's environment.
 * Rejects with a 404 ApiError for a connection the caller can't reach (or that does not exist).
 */
export async function getS3ConnectionLocation(id: string) {
  return parseResponse(
    routes["get-s3-connection-location"].$get({ query: { id } })
  );
}

export const s3ConnectionLocationQuery = (id: string) =>
  queryOptions({
    queryKey: ["s3-connections", "getS3ConnectionLocation", id],
    queryFn: () => getS3ConnectionLocation(id),
  });
