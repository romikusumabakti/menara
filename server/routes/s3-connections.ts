import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import { getS3ConnectionLocation } from "@/server/services/s3-connections";
import { query } from "@/server/validation";

// Where an old /storage/<id> link leads. The service takes the caller's right
// to view the connection's environment. Connections are created, edited and
// probed only as an environment's storage (environment-storage).
export const s3ConnectionsRouter = sessionRouter().get(
  "/get-s3-connection-location",
  query(z.object({ id: uuidSchema })),
  async (c) => c.json(await getS3ConnectionLocation(c.req.valid("query").id))
);
