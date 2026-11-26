import { z } from "zod";
import { environmentStorageSchema, uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  getEnvironmentStorage,
  removeEnvironmentStorage,
  saveEnvironmentStorage,
  testEnvironmentStorage,
} from "@/server/services/environment-storage";
import { json, param } from "@/server/validation";

const envParam = param(z.object({ id: uuidSchema }));

/**
 * An environment's one object storage, mounted at /api/environments. Each
 * service function checks the environment's rights itself (view: project
 * read; manage: environment update + strong sign-in).
 */
export const environmentStorageRouter = sessionRouter()
  .get("/:id/storage", envParam, async (c) =>
    c.json(await getEnvironmentStorage(c.req.valid("param").id))
  )
  .put("/:id/storage", envParam, json(environmentStorageSchema), async (c) =>
    c.json(
      await saveEnvironmentStorage(c.req.valid("param").id, c.req.valid("json"))
    )
  )
  .delete("/:id/storage", envParam, async (c) => {
    await removeEnvironmentStorage(c.req.valid("param").id);
    return c.json({ ok: true });
  })
  .post(
    "/:id/storage/test",
    envParam,
    // A probe of unsaved form values: the S3 client's own error is the
    // answer, so the fields are only bounded here.
    json(
      z.object({
        endpoint: z.string().max(2048),
        region: z.string().max(100),
        bucket: z.string().max(255),
        accessKeyId: z.string().max(512),
        secretKey: z.string().max(1024).optional(),
        forcePathStyle: z.boolean(),
        keyPrefix: z.string().max(2048).nullish(),
      })
    ),
    async (c) =>
      c.json(
        await testEnvironmentStorage(
          c.req.valid("param").id,
          c.req.valid("json")
        )
      )
  );
