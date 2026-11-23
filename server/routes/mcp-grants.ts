import { z } from "zod";
import { requireSession } from "@/lib/auth-session";
import { isMcpEnabled, MCP_RESOURCE } from "@/lib/mcp/config";
import {
  listAllGrants,
  listGrantsFor,
  revokeGrant,
  setMcpEnabled,
} from "@/lib/mcp/grants";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import { requireInstanceManage } from "@/server/services/instance-backups";
import { json, param } from "@/server/validation";

// A client id is a URL (CIMD) or a random id; it travels percent-encoded.
const clientIdSchema = z.string().min(1).max(2048);

/**
 * Account › Connected apps: the caller's own grants to MCP agents. A grant
 * that is not the caller's answers 404, like one that does not exist.
 */
export const connectedAppsRouter = sessionRouter()
  .get("/", async (c) => {
    const { user } = await requireSession();
    return c.json(await listGrantsFor(user.id));
  })
  // What the setup card needs; any signed-in user may read it.
  .get("/setup", async (c) =>
    c.json({ enabled: await isMcpEnabled(), resourceUrl: MCP_RESOURCE })
  )
  .delete(
    "/:clientId",
    param(z.object({ clientId: clientIdSchema })),
    async (c) => {
      const { user } = await requireSession();
      await revokeGrant(user.id, user.id, c.req.valid("param").clientId);
      return c.body(null, 204);
    }
  );

/**
 * Admin › Instance › MCP: the instance switch and every user's grants. The
 * router checks org instance:manage before any validator.
 */
export const instanceMcpRouter = sessionRouter()
  .use(async (_c, next) => {
    await requireInstanceManage();
    await next();
  })
  .get("/", async (c) =>
    c.json({
      enabled: await isMcpEnabled(),
      resourceUrl: MCP_RESOURCE,
      grants: await listAllGrants(),
    })
  )
  .put("/", json(z.object({ enabled: z.boolean() })), async (c) => {
    const { user } = await requireSession();
    const { enabled } = c.req.valid("json");
    await setMcpEnabled(user.id, enabled);
    return c.json({ enabled });
  })
  .delete(
    "/grants/:userId/:clientId",
    param(z.object({ userId: uuidSchema, clientId: clientIdSchema })),
    async (c) => {
      const { user } = await requireSession();
      const { userId, clientId } = c.req.valid("param");
      await revokeGrant(user.id, userId, clientId);
      return c.body(null, 204);
    }
  );
