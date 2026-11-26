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
    // A probe of unsaved form values, validated as a save would be.
    json(environmentStorageSchema),
    async (c) =>
      c.json(
        await testEnvironmentStorage(
          c.req.valid("param").id,
          c.req.valid("json")
        )
      )
  );
