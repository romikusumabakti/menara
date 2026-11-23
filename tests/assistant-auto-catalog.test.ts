import { describe, expect, it, vi } from "vitest";
import { createAutoToolContext } from "@/lib/assistant/auto-context";
import { autoToolCatalog, buildTools } from "@/lib/assistant/tool-defs";
import type { AssistantViewer } from "@/lib/assistant/viewer";

vi.mock("@/lib/assistant/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/viewer")>()),
  loadProjectEntries: async () => [],
}));

// The catalog the MCP server registers: the Assistant's auto-mode read tools,
// from the same definitions and inputs, for one viewer.

const viewerAs = (orgRole: AssistantViewer["orgRole"]): AssistantViewer => ({
  userId: "u1",
  orgRole,
  projectIds: ["p1"],
  canManageKnowledge: false,
  scope: {
    userId: "u1",
    orgRole,
    projectRoles: {
      p1: orgRole === "engineer" || orgRole === "admin" ? "engineer" : "qa",
    },
    seesAllProjects: false,
  },
});

const catalogNames = (viewer: AssistantViewer) =>
  autoToolCatalog(viewer).map((entry) => entry.name);

describe("autoToolCatalog", () => {
  it.each(["admin", "engineer", "qa"] as const)(
    "lists the same auto tools buildTools offers, minus read_upload (%s)",
    async (role) => {
      const viewer = viewerAs(role);
      const ctx = await createAutoToolContext(viewer, { timeZone: "UTC" });
      const offered = Object.keys(buildTools(ctx, async () => {})).filter(
        (name) => name !== "read_upload" && name !== "read_attachment"
      );
      expect(catalogNames(viewer)).toEqual(offered);
    }
  );

  it("omits list_tables/query_database for a viewer without database tools", () => {
    expect(catalogNames(viewerAs("qa"))).not.toContain("query_database");
    expect(catalogNames(viewerAs("qa"))).not.toContain("list_tables");
    expect(catalogNames(viewerAs("admin"))).toContain("query_database");
  });

  it("leaves read_attachment out: its core reads only attachments ticked on a chat message", () => {
    expect(catalogNames(viewerAs("admin"))).not.toContain("read_attachment");
  });

  it("gives every entry a description and a zod input that accepts empty input only where it takes none", () => {
    for (const entry of autoToolCatalog(viewerAs("admin"))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
      expect(typeof entry.input.safeParse, entry.name).toBe("function");
    }
    const list = autoToolCatalog(viewerAs("admin")).find(
      (e) => e.name === "list_projects"
    );
    expect(list?.input.safeParse({}).success).toBe(true);
    expect(list?.input.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("createAutoToolContext", () => {
  it("builds an auto context with no attachments or uploads", async () => {
    const ctx = await createAutoToolContext(viewerAs("qa"), {
      timeZone: "UTC",
    });
    expect(ctx.mode).toBe("auto");
    expect(ctx.attachments).toEqual([]);
    expect(ctx.uploads).toEqual([]);
    expect(ctx.nativeFiles).toBe(false);
  });
});
