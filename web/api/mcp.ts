import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const account = api.api.account["connected-apps"];
const instance = api.api.instance.mcp;

// --- Account › Connected apps (the caller's own grants) ---

export async function listConnectedApps() {
  return parseResponse(account.$get());
}

export const listConnectedAppsQuery = () =>
  queryOptions({
    queryKey: ["mcp", "listConnectedApps"],
    queryFn: listConnectedApps,
  });

export type McpGrantRow = Awaited<ReturnType<typeof listConnectedApps>>[number];

/** Whether the MCP server is on, and its URL, for the setup card. */
export async function getMcpSetup() {
  return parseResponse(account.setup.$get());
}

export const getMcpSetupQuery = () =>
  queryOptions({
    queryKey: ["mcp", "getMcpSetup"],
    queryFn: getMcpSetup,
  });

// The typed client does not encode path parameters, and a client id is
// usually a URL.
export async function revokeConnectedApp(clientId: string) {
  await parseResponse(
    account[":clientId"].$delete({
      param: { clientId: encodeURIComponent(clientId) },
    })
  );
}

// --- Admin › Instance › MCP ---

export async function getInstanceMcp() {
  return parseResponse(instance.$get());
}

export const getInstanceMcpQuery = () =>
  queryOptions({
    queryKey: ["mcp", "getInstanceMcp"],
    queryFn: getInstanceMcp,
  });

export type InstanceMcpData = Awaited<ReturnType<typeof getInstanceMcp>>;

export async function setInstanceMcpEnabled(enabled: boolean) {
  return parseResponse(instance.$put({ json: { enabled } }));
}

export async function revokeInstanceGrant(userId: string, clientId: string) {
  await parseResponse(
    instance.grants[":userId"][":clientId"].$delete({
      param: { userId, clientId: encodeURIComponent(clientId) },
    })
  );
}
