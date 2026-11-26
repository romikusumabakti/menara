import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

// An environment's one object storage (server/routes/environment-storage).
// Refusals reject with an ApiError; a bad key prefix carries the code
// `s3KeyPrefixInvalid`, a location change without a secret
// `s3SecretRequiredForLocationChange`.
const routes = api.api.environments[":id"].storage;

type SaveBody = Parameters<typeof routes.$put>[0]["json"];
type TestBody = Parameters<(typeof routes.test)["$post"]>[0]["json"];

async function getEnvironmentStorage(environmentId: string) {
  return parseResponse(routes.$get({ param: { id: environmentId } }));
}

/** The environment's storage without its secret, or null when unset. */
export const environmentStorageQuery = (environmentId: string) =>
  queryOptions({
    queryKey: ["environment-storage", environmentId],
    queryFn: () => getEnvironmentStorage(environmentId),
  });

export type EnvironmentStorageConfig = NonNullable<
  Awaited<ReturnType<typeof getEnvironmentStorage>>
>;

export async function saveEnvironmentStorage(
  environmentId: string,
  body: SaveBody
) {
  return parseResponse(
    routes.$put({ param: { id: environmentId }, json: body })
  );
}

export async function removeEnvironmentStorage(environmentId: string) {
  return parseResponse(routes.$delete({ param: { id: environmentId } }));
}

export async function testEnvironmentStorage(
  environmentId: string,
  body: TestBody
) {
  return parseResponse(
    routes.test.$post({ param: { id: environmentId }, json: body })
  );
}
