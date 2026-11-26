// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Projects pending skeleton mirrors the environment rows, including the
// xl grid, so nothing jumps when the real rows land.

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createFileRoute: () => (options: object) => ({
    options,
    useSearch: () => ({}),
  }),
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects",
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/web/project-guard", () => ({ requireProjectUser: vi.fn() }));
vi.mock("@/web/api/project-groups", () => ({ listGroupsQuery: vi.fn() }));
vi.mock("@/web/api/project-catalog", () => ({
  listProjectsWithEnvironmentsQuery: vi.fn(),
  getMyProjectAccessQuery: vi.fn(),
}));
vi.mock("@/web/api/environments", () => ({
  getEnvironmentsLastOpenedQuery: vi.fn(),
}));
vi.mock("@/web/api/issues", () => ({ getOpenIssueCountsQuery: vi.fn() }));
vi.mock("@/web/api/runs", () => ({
  getEnvironmentsLastActivityQuery: vi.fn(),
}));
vi.mock("@/web/api/session", () => ({
  meQuery: vi.fn(),
  useMe: () => null,
}));

import { ENV_ROW_GRID } from "@/components/projects-overview";
import { Route } from "../web/routes/$locale/_app/projects.index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let holder: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  holder.remove();
});

describe("Projects pending skeleton", () => {
  it("uses the real row grid and swaps the second line for xl cells", async () => {
    const Pending = Route.options.pendingComponent as React.ComponentType;
    holder = document.createElement("div");
    document.body.append(holder);
    root = createRoot(holder);
    await act(async () => root.render(<Pending />));
    const row = holder.querySelector("li");
    expect(row).not.toBeNull();
    for (const cls of ENV_ROW_GRID.split(" "))
      expect(row?.classList.contains(cls)).toBe(true);
    // the two-line detail bar is hidden at xl; xl-only bars stand in for the
    // DB type, DB name and owner cells
    expect(row?.querySelectorAll(".xl\\:hidden")).toHaveLength(1);
    expect(row?.querySelectorAll(".hidden.xl\\:block")).toHaveLength(3);
  });
});
