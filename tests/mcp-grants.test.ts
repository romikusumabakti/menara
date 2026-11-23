import { beforeEach, describe, expect, it, vi } from "vitest";

// The connected-apps routes (server/routes/mcp-grants.ts) on the production
// middleware stack: who may call what, and whose grants each route touches.
// The grants module is stubbed with an in-memory grant list; what listing and
// revoking do in the database is tests/mcp-grants-scratch.test.ts.

const ALICE = "01900000-0000-7000-8000-0000000000a1";
const BOB = "01900000-0000-7000-8000-0000000000b2";
const CLIENT = "https://agent.example.com/oauth/client.json";

type Grant = { userId: string; clientId: string };

const state = vi.hoisted(() => ({
  user: { id: "", role: "admin" },
  grants: [] as Grant[],
  enabled: false,
}));

vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: state.user,
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});

vi.mock("@/lib/mcp/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/config")>()),
  isMcpEnabled: async () => state.enabled,
}));

const grants = vi.hoisted(() => ({
  listGrantsFor: vi.fn(),
  listAllGrants: vi.fn(),
  revokeGrant: vi.fn(),
  setMcpEnabled: vi.fn(),
  recordGrantApproved: vi.fn(),
}));
vi.mock("@/lib/mcp/grants", () => grants);

const { app } = await import("@/server/app");
const { CodedHTTPException } = await import("@/server/errors");

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const as = (id: string, role: string) => {
  state.user = { id, role };
};

beforeEach(() => {
  state.grants = [
    { userId: ALICE, clientId: CLIENT },
    { userId: BOB, clientId: CLIENT },
  ];
  state.enabled = true;
  grants.listGrantsFor.mockReset();
  grants.listAllGrants.mockReset();
  grants.setMcpEnabled.mockReset();
  grants.listGrantsFor.mockImplementation(async (userId: string) =>
    state.grants.filter((g) => g.userId === userId)
  );
  grants.listAllGrants.mockImplementation(async () => state.grants);
  grants.revokeGrant.mockReset();
  // As lib/mcp/grants does: 404 unless that user holds the grant.
  grants.revokeGrant.mockImplementation(
    async (_actor: string, userId: string, clientId: string) => {
      const before = state.grants.length;
      state.grants = state.grants.filter(
        (g) => !(g.userId === userId && g.clientId === clientId)
      );
      if (state.grants.length === before) {
        throw new CodedHTTPException(404, "mcpGrantNotFound", "Not found");
      }
    }
  );
});

describe("connected apps routes", () => {
  it("lists only the caller's grants", async () => {
    as(BOB, "qa");
    const res = await send("GET", "/api/account/connected-apps");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ userId: BOB, clientId: CLIENT }]);
    expect(grants.listGrantsFor).toHaveBeenCalledWith(BOB);
    expect(grants.listAllGrants).not.toHaveBeenCalled();
  });

  it("serves the setup card to any signed-in user", async () => {
    as(BOB, "qa");
    const res = await send("GET", "/api/account/connected-apps/setup");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      resourceUrl: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.resourceUrl).toMatch(/\/api\/mcp$/);
  });

  it("a user cannot revoke another user's grant via the account route", async () => {
    // Bob revokes his own grant.
    as(BOB, "qa");
    const own = await send(
      "DELETE",
      `/api/account/connected-apps/${encodeURIComponent(CLIENT)}`
    );
    expect(own.status).toBe(204);
    expect(grants.revokeGrant).toHaveBeenLastCalledWith(BOB, BOB, CLIENT);

    // Again: his grant is gone, and Alice's (same client) is not his to take.
    const again = await send(
      "DELETE",
      `/api/account/connected-apps/${encodeURIComponent(CLIENT)}`
    );
    expect(again.status).toBe(404);
    expect(((await again.json()) as { code?: string }).code).toBe(
      "mcpGrantNotFound"
    );
    expect(state.grants).toEqual([{ userId: ALICE, clientId: CLIENT }]);
  });

  it("only instance managers can toggle and list all grants", async () => {
    for (const role of ["qa", "engineer", "observer"]) {
      as(BOB, role);
      expect((await send("GET", "/api/instance/mcp")).status).toBe(403);
      expect(
        (await send("PUT", "/api/instance/mcp", { enabled: false })).status
      ).toBe(403);
      expect(
        (
          await send(
            "DELETE",
            `/api/instance/mcp/grants/${ALICE}/${encodeURIComponent(CLIENT)}`
          )
        ).status
      ).toBe(403);
    }
    expect(grants.listAllGrants).not.toHaveBeenCalled();
    expect(grants.setMcpEnabled).not.toHaveBeenCalled();
    expect(grants.revokeGrant).not.toHaveBeenCalled();

    as(ALICE, "admin");
    const page = await send("GET", "/api/instance/mcp");
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      enabled: boolean;
      resourceUrl: string;
      grants: Grant[];
    };
    expect(body.enabled).toBe(true);
    expect(body.resourceUrl).toMatch(/\/api\/mcp$/);
    expect(body.grants).toHaveLength(2);

    const off = await send("PUT", "/api/instance/mcp", { enabled: false });
    expect(off.status).toBe(200);
    expect(grants.setMcpEnabled).toHaveBeenCalledWith(ALICE, false);
    expect(
      (await send("PUT", "/api/instance/mcp", { enabled: "yes" })).status
    ).toBe(400);

    const revoked = await send(
      "DELETE",
      `/api/instance/mcp/grants/${BOB}/${encodeURIComponent(CLIENT)}`
    );
    expect(revoked.status).toBe(204);
    expect(grants.revokeGrant).toHaveBeenLastCalledWith(ALICE, BOB, CLIENT);
  });
});
