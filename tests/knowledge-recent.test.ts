import { describe, expect, it, vi } from "vitest";

// GET /api/knowledge/recent through the real guard and router; the data layer
// is mocked (its SQL is covered in knowledge-visibility-scratch.test.ts).

const state = vi.hoisted(() => ({ role: "staff", calls: [] as unknown[] }));

vi.mock("@/lib/db", () => ({ db: {}, pgClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: { id: "u1", role: state.role },
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge")>()),
  listRecentlyEdited: async (viewer: unknown) => {
    state.calls.push(viewer);
    return [
      {
        slug: "runbook",
        title: "Runbook",
        docType: "doc",
        collection: { id: "c1", name: "ACME" },
        editedAt: new Date("2026-01-02T03:04:05Z"),
        editedBy: { id: "u2", name: "Alex" },
      },
    ];
  },
}));

const { app } = await import("@/server/app");

describe("GET /api/knowledge/recent", () => {
  it("answers { items } with ISO timestamps for the signed-in viewer", async () => {
    const res = await app.request("/api/knowledge/recent");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          slug: "runbook",
          title: "Runbook",
          docType: "doc",
          collection: { id: "c1", name: "ACME" },
          editedAt: "2026-01-02T03:04:05.000Z",
          editedBy: { id: "u2", name: "Alex" },
        },
      ],
    });
    expect(state.calls[0]).toMatchObject({ userId: "u1", role: "staff" });
  });
});
