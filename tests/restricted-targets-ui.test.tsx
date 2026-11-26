import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

// The browser side of restricted targets: the page guard for a terminal or
// file page takes the org role alone on an infra-only server.

import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { meQuery } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";

function signedIn(orgRole: string, roles: Record<string, string>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(meQuery().queryKey, {
    id: "u1",
    orgRole,
  } as never);
  queryClient.setQueryData(getMyProjectAccessQuery().queryKey, {
    all: false,
    roles,
  } as never);
  return queryClient;
}

describe("requireOrgRole on a restricted target", () => {
  it("lets an engineer member through on a normal target only", async () => {
    const queryClient = signedIn("engineer", { p1: "engineer" });
    await expect(
      requireOrgRole(queryClient, { server: ["terminal"] })
    ).resolves.toBeDefined();
    await expect(
      requireOrgRole(queryClient, { server: ["terminal"] }, true)
    ).rejects.toMatchObject({ isNotFound: true });
    await expect(
      requireOrgRole(queryClient, { storage: ["files"] }, true)
    ).rejects.toMatchObject({ isNotFound: true });
  });

  it("lets infra through on a restricted target", async () => {
    const queryClient = signedIn("infra", {});
    await expect(
      requireOrgRole(queryClient, { server: ["files"] }, true)
    ).resolves.toBeDefined();
  });
});
