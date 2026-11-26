import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectAccess } from "@/lib/assistant/auto-context";
import {
  instanceOrigin,
  personRef,
  projectRef,
} from "@/lib/assistant/tools/links";

const saved = process.env.BETTER_AUTH_URL;
beforeEach(() => {
  process.env.BETTER_AUTH_URL = "https://panel.example.com/some/path";
});
afterEach(() => {
  if (saved === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = saved;
});

describe("assistant tool links", () => {
  it("builds absolute person and project urls on the instance origin", () => {
    expect(personRef({ id: "u1", name: "Ana" })).toEqual({
      name: "Ana",
      profileUrl: "https://panel.example.com/people/u1",
    });
    expect(projectRef({ key: "ACME", name: "Acme Membership" })).toEqual({
      key: "ACME",
      name: "Acme Membership",
      url: "https://panel.example.com/ACME",
    });
  });

  it("defaults to localhost:3000 like lib/auth.ts", () => {
    delete process.env.BETTER_AUTH_URL;
    expect(instanceOrigin()).toBe("http://localhost:3000");
  });

  it("list_projects entries carry the project url", async () => {
    const access = projectAccess(
      [
        {
          id: "p1",
          key: "ACME",
          name: "Acme Membership",
          group: null,
          description: null,
        },
      ],
      {
        resolveProjectSources: async () => [],
        ensureSnapshot: async () => ({}) as never,
        loadProjects: async () => [],
      }
    );
    expect(await access.listProjects()).toEqual([
      {
        key: "ACME",
        name: "Acme Membership",
        url: "https://panel.example.com/ACME",
        group: null,
        description: null,
        components: [],
      },
    ]);
  });
});
