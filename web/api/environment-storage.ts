import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { ApiError, api } from "@/web/api/client";

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

// --- Transitional shims for the per-connection pages (storage list, edit,
// files, new) until the Settings › Storage tab and the storage explorer page
// replace them. They map the one storage onto the old row shape (id = the
// environment id) and the old calls onto the new endpoints. Delete with
// those pages.

/** @deprecated The per-connection row shape; use EnvironmentStorageConfig. */
export type EnvironmentStorageRow = Omit<
  EnvironmentStorageConfig,
  "environmentId"
> & {
  id: string;
  name: string;
  environmentId: string | null;
};

function asRow(storage: EnvironmentStorageConfig): EnvironmentStorageRow {
  return { ...storage, id: storage.environmentId, name: storage.bucket };
}

/** @deprecated The list page's rows: the one storage, or none. */
export const environmentStorageRowsQuery = (environmentId: string) =>
  queryOptions({
    queryKey: ["environment-storage", environmentId, "rows"],
    queryFn: async () => {
      const storage = await getEnvironmentStorage(environmentId);
      return storage ? [asRow(storage)] : [];
    },
  });

/** @deprecated The edit page's row; a 404 when unset. */
export const environmentStorageConnectionQuery = (
  environmentId: string,
  _connectionId: string
) =>
  queryOptions({
    queryKey: ["environment-storage", environmentId, "row"],
    queryFn: async () => {
      const storage = await getEnvironmentStorage(environmentId);
      if (!storage) throw new ApiError(404, "Not found");
      return asRow(storage);
    },
  });

type LegacyBody = Omit<SaveBody, "secretKey"> & {
  name?: string;
  secretKey?: string;
};

/** @deprecated Use saveEnvironmentStorage. */
export async function createEnvironmentStorage(
  environmentId: string,
  { name: _name, ...body }: LegacyBody
) {
  return saveEnvironmentStorage(environmentId, body);
}

/** @deprecated Use saveEnvironmentStorage. */
export async function updateEnvironmentStorage(
  environmentId: string,
  _connectionId: string,
  { name: _name, ...body }: LegacyBody
) {
  return saveEnvironmentStorage(environmentId, body);
}

/** @deprecated Use removeEnvironmentStorage. */
export async function deleteEnvironmentStorage(
  environmentId: string,
  _connectionId: string
) {
  return removeEnvironmentStorage(environmentId);
}
